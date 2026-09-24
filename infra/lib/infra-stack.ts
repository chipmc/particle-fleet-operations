import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as path from 'path';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // Storage Resources
    // =========================================================================

    const rawLogsBucket = new s3.Bucket(this, 'RawParticleLogsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireDynamoIndexArchiveAfterTwoYears',
          prefix: 'dynamodb-index-archive/',
          expiration: Duration.days(730),
          noncurrentVersionExpiration: Duration.days(730),
        },
      ],
    });

    const logEventsTable = new dynamodb.Table(this, 'ParticleLogEventsTable', {
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventTime', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const deviceCurrentStateTable = new dynamodb.Table(this, 'DeviceCurrentStateTable', {
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const eventHistoryTable = new dynamodb.Table(this, 'DeviceEventHistoryTable', {
      partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventTime', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Single-table lock/fencing/failure-reconciliation store for the monthly archive job.
    // See lambda/src/archive-coordination.ts for item shapes. The `ttl` attribute is
    // cleanup-only for RUN items -- it is never written on the LOCK item and never read
    // for correctness (the fencing token must never expire or reset).
    const archiveCoordinationTable = new dynamodb.Table(this, 'ArchiveCoordinationTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // =========================================================================
    // Particle Ingestion Configuration (SSM Parameter Store / Secrets Manager)
    // =========================================================================

    // Previously these eight values were read as `process.env.X || '<fallback>'` directly in
    // this CDK app, which meant a `cdk deploy` run from any shell missing one of these exports
    // silently overwrote the live, correct value with an empty/wrong fallback -- confirmed as a
    // real, standing risk (it nearly happened during the archival-feature deploy) and not
    // something `cdk diff` could warn about, since the "fallback" was itself the value CDK
    // computed and considered correct.
    //
    // Below, each of these becomes a CloudFormation dynamic reference (`{{resolve:ssm:...}}` /
    // `{{resolve:secretsmanager:...}}`) instead of a literal string baked in at synth time.
    // CloudFormation itself resolves the current value from SSM/Secrets Manager at deploy time,
    // independent of the deploying shell's environment entirely -- so a missing shell export can
    // no longer cause drift here at all, and `cdk diff` run from a completely clean shell shows
    // zero changes to this function. The values themselves are managed entirely out-of-band
    // (via `aws ssm put-parameter` / `aws secretsmanager put-secret-value`), never in this
    // source file -- for the two secrets specifically, that also means no plaintext credential
    // ever appears in the synthesized template or in `cdk diff` output.
    const particleIngestionSsmPrefix = '/particle-fleet-operations/ingestion';
    const particleApiBaseUrl = ssm.StringParameter.valueForStringParameter(
      this, `${particleIngestionSsmPrefix}/particle-api-base-url`);
    const ledgerRefreshEnabled = ssm.StringParameter.valueForStringParameter(
      this, `${particleIngestionSsmPrefix}/ledger-refresh-enabled`);
    const ledgerRefreshDeviceIds = ssm.StringParameter.valueForStringParameter(
      this, `${particleIngestionSsmPrefix}/ledger-refresh-device-ids`);
    const ledgerRefreshProductIds = ssm.StringParameter.valueForStringParameter(
      this, `${particleIngestionSsmPrefix}/ledger-refresh-product-ids`);
    const ledgerRefreshEventNames = ssm.StringParameter.valueForStringParameter(
      this, `${particleIngestionSsmPrefix}/ledger-refresh-event-names`);
    const ledgerRefreshMinIntervalSeconds = ssm.StringParameter.valueForStringParameter(
      this, `${particleIngestionSsmPrefix}/ledger-refresh-min-interval-seconds`);

    const particleCredentials = secretsmanager.Secret.fromSecretNameV2(
      this, 'ParticleCredentialsSecret', 'particle-fleet-operations/ingestion/particle-credentials');
    const particleAccessToken = particleCredentials.secretValueFromJson('PARTICLE_ACCESS_TOKEN').unsafeUnwrap();
    const particleWebhookSecret = particleCredentials.secretValueFromJson('PARTICLE_WEBHOOK_SECRET').unsafeUnwrap();

    // =========================================================================
    // Lambda Function (handles both ingestion and query)
    // =========================================================================

    const ingestionFunction = new NodejsFunction(this, 'ParticleLogIngestionFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/src/handler.ts'),
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'es2022',
        externalModules: [],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(__dirname, '../../lambda/package-lock.json'),
      projectRoot: path.join(__dirname, '../../lambda'),
      environment: {
        RAW_LOGS_BUCKET_NAME: rawLogsBucket.bucketName,
        LOG_EVENTS_TABLE_NAME: logEventsTable.tableName,
        DEVICE_CURRENT_STATE_TABLE_NAME: deviceCurrentStateTable.tableName,
        EVENT_HISTORY_TABLE_NAME: eventHistoryTable.tableName,
        PARTICLE_ACCESS_TOKEN: particleAccessToken,
        PARTICLE_API_BASE_URL: particleApiBaseUrl,
        PARTICLE_WEBHOOK_SECRET: particleWebhookSecret,
        PARTICLE_LEDGER_REFRESH_ENABLED: ledgerRefreshEnabled,
        PARTICLE_LEDGER_REFRESH_DEVICE_IDS: ledgerRefreshDeviceIds,
        PARTICLE_LEDGER_REFRESH_PRODUCT_IDS: ledgerRefreshProductIds,
        PARTICLE_LEDGER_REFRESH_EVENT_NAMES: ledgerRefreshEventNames,
        PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS: ledgerRefreshMinIntervalSeconds,
      },
    });

    const archiveTopic = new sns.Topic(this, 'MonthlyArchiveNotifications', {
      displayName: 'Particle monthly telemetry archive',
    });
    archiveTopic.addSubscription(new subscriptions.EmailSubscription('chip@seeinsights.com'));

    const archiveFunction = new NodejsFunction(this, 'MonthlyLogArchiveFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../lambda/src/archive-control.ts'),
      timeout: Duration.minutes(15),
      memorySize: 1024,
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'es2022',
        externalModules: [],
        forceDockerBundling: false,
      },
      depsLockFilePath: path.join(__dirname, '../../lambda/package-lock.json'),
      projectRoot: path.join(__dirname, '../../lambda'),
      environment: {
        RAW_LOGS_BUCKET_NAME: rawLogsBucket.bucketName,
        LOG_EVENTS_TABLE_NAME: logEventsTable.tableName,
        ARCHIVE_COORDINATION_TABLE_NAME: archiveCoordinationTable.tableName,
        ARCHIVE_DELETE_ENABLED: 'false',
        ARCHIVE_SCAN_PAGE_SIZE: '250',
        ARCHIVE_NOTIFICATION_TOPIC_ARN: archiveTopic.topicArn,
      },
    });

    logEventsTable.grantReadData(archiveFunction);
    rawLogsBucket.grantReadWrite(archiveFunction, 'dynamodb-index-archive/*');
    archiveTopic.grantPublish(archiveFunction);
    archiveFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'ParticleFleetOperations/Archive' } },
    }));
    // Deliberately not Table.grantReadWriteData(): that grant includes dynamodb:DeleteItem,
    // and the whole point of the fencing-token redesign is that this function's own role
    // never has delete access to the lock -- releaseLock (archive-coordination.ts) clears
    // ownership fields with UpdateItem, it never deletes the item, so the fencing token is
    // never lost. DeleteItem on the LOCK#monthly-archive key exists only on the break-glass
    // operator role below, gated by dynamodb:LeadingKeys, for manual, ticketed recovery.
    archiveFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:TransactWriteItems',
      ],
      resources: [archiveCoordinationTable.tableArn],
    }));

    const startArchive = new tasks.LambdaInvoke(this, 'StartMonthlyArchive', {
      lambdaFunction: archiveFunction,
      payload: sfn.TaskInput.fromObject({
        action: 'START',
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
        executionStartedAt: sfn.JsonPath.stringAt('$$.Execution.StartTime'),
      }),
      outputPath: '$.Payload',
    });
    const processArchivePage = new tasks.LambdaInvoke(this, 'CopyAndVerifyArchivePage', {
      lambdaFunction: archiveFunction,
      payload: sfn.TaskInput.fromObject({
        action: 'PROCESS_PAGE',
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
        runId: sfn.JsonPath.stringAt('$.runId'),
        cutoff: sfn.JsonPath.stringAt('$.cutoff'),
        pageNumber: sfn.JsonPath.numberAt('$.pageNumber'),
        fencingToken: sfn.JsonPath.numberAt('$.fencingToken'),
        'exclusiveStartKey.$': '$.exclusiveStartKey',
      }),
      outputPath: '$.Payload',
    });
    const nextArchivePage = new sfn.Pass(this, 'PrepareNextArchivePage', {
      parameters: {
        action: 'PROCESS_PAGE',
        'runId.$': '$.runId',
        'cutoff.$': '$.cutoff',
        'pageNumber.$': '$.nextPageNumber',
        'exclusiveStartKey.$': '$.lastEvaluatedKey',
        'fencingToken.$': '$.fencingToken',
      },
    });
    const finalizeArchive = new tasks.LambdaInvoke(this, 'FinalizeMonthlyArchive', {
      lambdaFunction: archiveFunction,
      payload: sfn.TaskInput.fromObject({
        action: 'FINALIZE',
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
        runId: sfn.JsonPath.stringAt('$.runId'),
        cutoff: sfn.JsonPath.stringAt('$.cutoff'),
        fencingToken: sfn.JsonPath.numberAt('$.fencingToken'),
      }),
      outputPath: '$.Payload',
    });
    const publishArchiveReport = new tasks.SnsPublish(this, 'EmailMonthlyArchiveReport', {
      topic: archiveTopic,
      subject: sfn.JsonPath.stringAt('$.subject'),
      message: sfn.TaskInput.fromJsonPathAt('$.message'),
    });
    const recordArchiveFailure = new tasks.LambdaInvoke(this, 'RecordMonthlyArchiveFailure', {
      lambdaFunction: archiveFunction,
      payload: sfn.TaskInput.fromObject({
        action: 'RECONCILE_FAILURE',
        context: sfn.JsonPath.objectAt('$'),
        error: sfn.JsonPath.objectAt('$.failure'),
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
      outputPath: '$.Payload',
    });
    // ASL topology change from the prior round: the standalone EmailMonthlyArchiveFailure
    // SnsPublish task is gone. SNS publish for the failure path now happens *inside*
    // reconcileFailure (lambda/src/archive-coordination.ts), gated by the same
    // PENDING->SENDING->SENT claim as the report write, so a failure this Catch branch
    // reconciles a second time (or that the EventBridge cleanup rule reconciles
    // independently) does not send a duplicate notification the way the old
    // unconditional SnsPublish task would have.
    recordArchiveFailure.next(new sfn.Fail(this, 'MonthlyArchiveFailed'));
    for (const task of [startArchive, processArchivePage, finalizeArchive]) {
      task.addCatch(recordArchiveFailure, { resultPath: '$.failure' });
    }
    const archivePageChoice = new sfn.Choice(this, 'ArchiveScanComplete?');
    processArchivePage.next(archivePageChoice
      .when(sfn.Condition.booleanEquals('$.complete', true), finalizeArchive.next(publishArchiveReport))
      .otherwise(nextArchivePage.next(processArchivePage)));

    // Named explicitly (rather than left to CDK's auto-generated name) so the
    // states:DescribeExecution ARN pattern below can be built from this literal string
    // instead of archiveStateMachine.stateMachineName. Deriving it from the resource
    // token would make the function's own role policy depend on the state machine
    // resource -- which already depends back on the function (its role grants
    // lambda:InvokeFunction on this function) -- producing an undeployable
    // CloudFormation dependency cycle. Confirmed by `cdk synth`/`npm test` failing with
    // exactly that cycle before this was changed to a literal name.
    const ARCHIVE_STATE_MACHINE_NAME = 'MonthlyLogArchive';
    const archiveStateMachine = new sfn.StateMachine(this, 'MonthlyLogArchiveStateMachine', {
      stateMachineName: ARCHIVE_STATE_MACHINE_NAME,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(startArchive.next(processArchivePage)),
      timeout: Duration.hours(12),
    });

    // Scoped to this state machine's own executions specifically -- shared by the
    // Lambda's own DescribeExecution call inside reconcileFailure (EventBridge-path
    // evidence enrichment) and by the break-glass operator role below (confirming an
    // execution is terminal before a manual lock delete).
    const archiveExecutionArnPattern = cdk.Arn.format(
      {
        service: 'states',
        resource: 'execution',
        resourceName: `${ARCHIVE_STATE_MACHINE_NAME}:*`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      },
      this
    );
    archiveFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:DescribeExecution'],
      resources: [archiveExecutionArnPattern],
    }));

    // Dead-letter queue for the failure-reconciliation EventBridge target: if
    // reconcileFailure keeps throwing across all retries (e.g. the coordination table is
    // unreachable), the event lands here instead of being silently dropped, and the alarm
    // below pages the same SNS topic the archive job already uses.
    const archiveReconciliationDlq = new sqs.Queue(this, 'MonthlyArchiveReconciliationDLQ', {
      retentionPeriod: Duration.days(14),
    });

    // EventBridge invokes this Lambda target asynchronously. Its own retryAttempts/DLQ
    // below cover EventBridge failing to *hand off* the invocation (throttling, etc) --
    // once Lambda accepts the async invoke, EventBridge considers delivery successful and
    // never sees whether reconcileFailure itself throws. That failure mode is covered
    // separately here, by Lambda's own asynchronous-invocation failure destination, which
    // is what actually observes the function's outcome after its own retries are
    // exhausted. Both point at the same queue/alarm -- either failure mode looks the same
    // to an operator.
    archiveFunction.configureAsyncInvoke({
      onFailure: new destinations.SqsDestination(archiveReconciliationDlq),
      retryAttempts: 2,
    });

    new events.Rule(this, 'MonthlyArchiveFailureLockCleanup', {
      eventPattern: {
        source: ['aws.states'],
        detailType: ['Step Functions Execution Status Change'],
        detail: {
          stateMachineArn: [archiveStateMachine.stateMachineArn],
          status: ['FAILED', 'TIMED_OUT', 'ABORTED'],
        },
      },
      targets: [new eventTargets.LambdaFunction(archiveFunction, {
        deadLetterQueue: archiveReconciliationDlq,
        retryAttempts: 3,
        maxEventAge: Duration.hours(1),
        event: events.RuleTargetInput.fromObject({
          action: 'RECONCILE_FAILURE',
          executionArn: events.EventField.fromPath('$.detail.executionArn'),
          executionStartedAt: events.EventField.fromPath('$.detail.startDate'),
          status: events.EventField.fromPath('$.detail.status'),
        }),
      })],
    });

    const archiveReconciliationDlqAlarm = new cloudwatch.Alarm(this, 'MonthlyArchiveReconciliationDlqAlarm', {
      metric: archiveReconciliationDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'The monthly archive failure-reconciliation EventBridge target exhausted its retries. A failed archive execution may not have had its report written or its lock released -- check the DLQ and consider tools/archive-lock-release.',
    });
    archiveReconciliationDlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(archiveTopic));

    // First human-assumable role in this stack (every other iam.Role here is
    // service-assumed). Fails closed at synth time rather than defaulting to some broad
    // account principal, since this role's only purpose is a manual, ticketed, audited
    // override of the archive lock -- an unintentionally-permissive default here would
    // defeat the point of making that path deliberately narrow.
    const archiveOperatorPrincipalArn = this.node.tryGetContext('archiveOperatorPrincipalArn');
    if (!archiveOperatorPrincipalArn) {
      throw new Error(
        'Missing required CDK context "archiveOperatorPrincipalArn". The break-glass ' +
        'archive-lock-release role must be assumable by a specific, known principal ARN -- ' +
        'pass it with --context archiveOperatorPrincipalArn=<iam-principal-arn> (see ' +
        '"Break-glass recovery" in docs/operations.md). Refusing to synthesize with an ' +
        'unspecified break-glass principal.'
      );
    }
    const archiveBreakGlassRole = new iam.Role(this, 'ArchiveLockBreakGlassRole', {
      assumedBy: new iam.ArnPrincipal(archiveOperatorPrincipalArn),
      description:
        'Break-glass recovery role for tools/archive-lock-release. Grants exactly the ' +
        'DynamoDB DeleteItem on the archive lock partition key, and DescribeExecution, ' +
        'needed to manually clear a stuck monthly-archive lock after confirming the ' +
        'owning execution is terminal.',
    });
    archiveBreakGlassRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:DeleteItem'],
      resources: [archiveCoordinationTable.tableArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': ['LOCK#monthly-archive'],
        },
      },
    }));
    archiveBreakGlassRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:DescribeExecution'],
      resources: [archiveExecutionArnPattern],
    }));

    const schedulerRole = new iam.Role(this, 'MonthlyArchiveSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    archiveStateMachine.grantStartExecution(schedulerRole);
    new scheduler.CfnSchedule(this, 'MonthlyLogArchiveSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 2 1 * ? *)',
      scheduleExpressionTimezone: 'UTC',
      target: {
        arn: archiveStateMachine.stateMachineArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    const archiveCompletionMetric = new cloudwatch.Metric({
      namespace: 'ParticleFleetOperations/Archive',
      metricName: 'RunCompleted',
      statistic: 'Sum',
      period: Duration.days(1),
    });
    // Seven daily breaches occur only when days 1-7 contain no completion.
    // Outside that calendar window the expression is healthy, avoiding a
    // false alarm during the normal gap between monthly executions.
    const monthlyArchiveCompletionWindow = new cloudwatch.MathExpression({
      expression: 'IF(DATE(FILL(completed, 0)) <= 7, FILL(completed, 0), 1)',
      usingMetrics: { completed: archiveCompletionMetric },
      period: Duration.days(1),
      label: 'Monthly archive completed during days 1-7',
    });
    const missedArchiveAlarm = new cloudwatch.Alarm(this, 'MonthlyArchiveMissedRunAlarm', {
      metric: monthlyArchiveCompletionWindow,
      threshold: 1,
      evaluationPeriods: 7,
      datapointsToAlarm: 7,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'No successful or partial monthly archive completion was recorded during days 1-7 of the month.',
    });
    missedArchiveAlarm.addAlarmAction(new cloudwatchActions.SnsAction(archiveTopic));

    // -------------------------------------------------------------------------
    // IAM Permissions (Least Privilege)
    // -------------------------------------------------------------------------

    // Phase 1 + 2A: Ingestion requires S3 write + DynamoDB write
    rawLogsBucket.grantWrite(ingestionFunction);
    logEventsTable.grantWriteData(ingestionFunction);

    ingestionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ],
      resources: [
        deviceCurrentStateTable.tableArn,
      ],
    }));

    // Phase 4: EventHistory write permission (PutItem only, append-only log)
    ingestionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem'],
      resources: [eventHistoryTable.tableArn],
    }));

    // Phase 2B: Query API requires DynamoDB Query only (no S3, no Scan)
    // Grant minimal DynamoDB read permissions for per-device queries
    ingestionFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Query',           // Required: Per-device time-range queries
        'dynamodb:DescribeTable',   // Optional: Table metadata for SDK
      ],
      resources: [
        logEventsTable.tableArn,
      ],
    }));

    // =========================================================================
    // HTTP API Gateway
    // =========================================================================

    const httpApi = new apigwv2.HttpApi(this, 'ParticleLogIngestionApi', {
      apiName: 'particle-log-ingestion-api',
    });

    // Added during the 2026-09-18 webhook-secret-compromise incident: the Lambda's own
    // application logs never capture source IP or headers (a failed auth check returns
    // before the body is even parsed, so there isn't even a deviceId to go on), and this
    // API previously had no access logging at all -- leaving no way to identify what was
    // still sending the old secret once it was clear more than one caller was involved.
    const httpApiAccessLogGroup = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    httpApiAccessLogGroup.grantWrite(new iam.ServicePrincipal('apigateway.amazonaws.com'));
    const cfnDefaultStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    cfnDefaultStage.accessLogSettings = {
      destinationArn: httpApiAccessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        requestTime: '$context.requestTime',
        sourceIp: '$context.identity.sourceIp',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        userAgent: '$context.identity.userAgent',
        integrationError: '$context.integrationErrorMessage',
      }),
    };

    // Phase 1 + 2A: Ingestion endpoint (POST /particle/log)
    httpApi.addRoutes({
      path: '/particle/log',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'ParticleLogIngestionIntegration',
        ingestionFunction
      ),
    });

    // Phase 2B: Query API endpoints (GET /device/{deviceId}/...)
    // All query endpoints share the same Lambda handler with internal routing

    // GET /device/{deviceId}/timeline
    httpApi.addRoutes({
      path: '/device/{deviceId}/timeline',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'TimelineQueryIntegration',
        ingestionFunction
      ),
    });

    // GET /device/{deviceId}/health
    httpApi.addRoutes({
      path: '/device/{deviceId}/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'HealthQueryIntegration',
        ingestionFunction
      ),
    });

    // GET /device/{deviceId}/summary
    httpApi.addRoutes({
      path: '/device/{deviceId}/summary',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'SummaryQueryIntegration',
        ingestionFunction
      ),
    });

    // GET /device/{deviceId}/anomalies
    httpApi.addRoutes({
      path: '/device/{deviceId}/anomalies',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'AnomaliesQueryIntegration',
        ingestionFunction
      ),
    });

    // Phase 3A: Fleet Intelligence endpoints backed by DeviceCurrentState

    // GET /fleet/summary
    httpApi.addRoutes({
      path: '/fleet/summary',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'FleetSummaryIntegration',
        ingestionFunction
      ),
    });

    // GET /fleet/anomalies
    httpApi.addRoutes({
      path: '/fleet/anomalies',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'FleetAnomaliesIntegration',
        ingestionFunction
      ),
    });

    // GET /fleet/offline
    httpApi.addRoutes({
      path: '/fleet/offline',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'FleetOfflineIntegration',
        ingestionFunction
      ),
    });

    // =========================================================================
    // Ingestion Custom Domain (Phase 4 migration, staged)
    // =========================================================================

    // Deliberately just the DomainName resource and its output -- no base path mapping,
    // no REST API, no per-consumer resources yet. This is the first, isolated step of the
    // per-consumer-credentials migration (see docs/security/webhook-secret-rotation-runbook.md
    // and the Phase 3/4 review history): it exists solely to produce a real
    // RegionalDomainName value so the CNAME can be added in Hover and DNS/TLS verified
    // before anything else in the migration proceeds. Everything downstream (the REST API,
    // the base path mapping, per-consumer secrets/API keys/usage plans) is a separate,
    // later, explicitly-authorized step.
    const ingestionCustomDomainCertificate = acm.Certificate.fromCertificateArn(
      this,
      'IngestionCustomDomainCertificate',
      'arn:aws:acm:us-east-1:564771499971:certificate/8475bfaa-b596-4a4c-9b7d-5762646829c3'
    );
    const ingestionCustomDomain = new apigateway.DomainName(this, 'IngestionCustomDomain', {
      domainName: 'ingest.seeinsights.com',
      certificate: ingestionCustomDomainCertificate,
      endpointType: apigateway.EndpointType.REGIONAL,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
    });
    new cdk.CfnOutput(this, 'IngestionCustomDomainRegionalDomainName', {
      value: ingestionCustomDomain.domainNameAliasDomainName,
      description: 'CNAME target for ingest.seeinsights.com in Hover (regional API Gateway custom domain, not yet mapped to any API)',
    });

    // =========================================================================
    // CloudFormation Outputs
    // =========================================================================

    new cdk.CfnOutput(this, 'ParticleLogIngestionUrl', {
      value: `${httpApi.apiEndpoint}/particle/log`,
      description: 'Ingestion endpoint (POST)',
    });

    new cdk.CfnOutput(this, 'QueryApiBaseUrl', {
      value: `${httpApi.apiEndpoint}/device`,
      description: 'Query API base URL (GET /device/{deviceId}/...)',
    });

    new cdk.CfnOutput(this, 'RawLogsBucketName', {
      value: rawLogsBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'LogEventsTableName', {
      value: logEventsTable.tableName,
    });

    new cdk.CfnOutput(this, 'DeviceCurrentStateTableName', {
      value: deviceCurrentStateTable.tableName,
    });

    new cdk.CfnOutput(this, 'EventHistoryTableName', {
      value: eventHistoryTable.tableName,
    });

    new cdk.CfnOutput(this, 'ArchiveCoordinationTableName', {
      value: archiveCoordinationTable.tableName,
    });

    new cdk.CfnOutput(this, 'MonthlyLogArchiveStateMachineArn', {
      value: archiveStateMachine.stateMachineArn,
    });

    new cdk.CfnOutput(this, 'ArchiveLockBreakGlassRoleArn', {
      value: archiveBreakGlassRole.roleArn,
    });
  }
}
