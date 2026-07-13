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
        PARTICLE_ACCESS_TOKEN: process.env.PARTICLE_ACCESS_TOKEN || '',
        PARTICLE_API_BASE_URL: process.env.PARTICLE_API_BASE_URL || 'https://api.particle.io',
        PARTICLE_WEBHOOK_SECRET: process.env.PARTICLE_WEBHOOK_SECRET || '',
        PARTICLE_LEDGER_REFRESH_ENABLED: process.env.PARTICLE_LEDGER_REFRESH_ENABLED || "false",
        PARTICLE_LEDGER_REFRESH_DEVICE_IDS:process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS || "",
        PARTICLE_LEDGER_REFRESH_EVENT_NAMES: process.env.PARTICLE_LEDGER_REFRESH_EVENT_NAMES || '',
        PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS: process.env.PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS || '60',
      },
    });

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
  }
}
