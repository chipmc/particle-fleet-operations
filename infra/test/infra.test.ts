import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';

const BREAK_GLASS_PRINCIPAL_ARN = 'arn:aws:iam::123456789012:role/test-archive-operator';

function template(context: Record<string, unknown> = {}): Template {
	return Template.fromStack(new InfraStack(new cdk.App({
		context: { archiveOperatorPrincipalArn: BREAK_GLASS_PRINCIPAL_ARN, ...context },
	}), 'TestStack'));
}

test('monthly archive is scheduled with deletion disabled', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::Scheduler::Schedule', {
		ScheduleExpression: 'cron(0 2 1 * ? *)',
		ScheduleExpressionTimezone: 'UTC',
	});
	synthesized.hasResourceProperties('AWS::Lambda::Function', {
		Environment: {
			Variables: Match.objectLike({
				ARCHIVE_DELETE_ENABLED: 'false',
				ARCHIVE_NOTIFICATION_TOPIC_ARN: Match.anyValue(),
			}),
		},
	});
	synthesized.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
	synthesized.hasResourceProperties('AWS::Events::Rule', {
		EventPattern: {
			source: ['aws.states'],
			'detail-type': ['Step Functions Execution Status Change'],
			detail: Match.objectLike({
				status: ['FAILED', 'TIMED_OUT', 'ABORTED'],
			}),
		},
		State: 'ENABLED',
	});
	synthesized.hasResourceProperties('AWS::CloudWatch::Alarm', {
		ComparisonOperator: 'LessThanThreshold',
		DatapointsToAlarm: 7,
		EvaluationPeriods: 7,
		Threshold: 1,
		TreatMissingData: 'notBreaching',
		Metrics: Match.arrayWith([
			Match.objectLike({
				Expression: 'IF(DATE(FILL(completed, 0)) <= 7, FILL(completed, 0), 1)',
			}),
		]),
	});
});

test('archive storage expires after two years and archive role has no DynamoDB delete permission', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::S3::Bucket', {
		LifecycleConfiguration: {
			Rules: Match.arrayWith([
				Match.objectLike({ Prefix: 'dynamodb-index-archive/', ExpirationInDays: 730, Status: 'Enabled' }),
			]),
		},
	});
	const buckets = synthesized.findResources('AWS::S3::Bucket');
	expect(JSON.stringify(buckets)).not.toContain('particle-events/');

	const policies = synthesized.findResources('AWS::IAM::Policy');
	const archivePolicies = Object.values(policies).filter(resource =>
		JSON.stringify(resource).includes('MonthlyLogArchiveFunction'));
	expect(archivePolicies.length).toBeGreaterThan(0);
	// The archive function's own role must never be able to delete a coordination-table
	// item: releaseLock (archive-coordination.ts) only ever UpdateItems the lock, and
	// DeleteItem on the lock key exists exclusively on the break-glass operator role,
	// scoped by dynamodb:LeadingKeys, for manual/ticketed recovery.
	expect(JSON.stringify(archivePolicies)).not.toContain('dynamodb:DeleteItem');
	expect(JSON.stringify(archivePolicies)).toContain('dynamodb:TransactWriteItems');
	expect(JSON.stringify(archivePolicies)).toContain('states:DescribeExecution');
	expect(JSON.stringify(archivePolicies)).toContain('sns:Publish');
	expect(JSON.stringify(archivePolicies)).toContain('MonthlyArchiveNotifications');
});

test('synth fails closed when archiveOperatorPrincipalArn context is absent', () => {
	expect(() => Template.fromStack(new InfraStack(new cdk.App(), 'TestStack')))
		.toThrow('archiveOperatorPrincipalArn');
});

test('archive coordination table has point-in-time recovery, a TTL attribute, and is retained', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::DynamoDB::Table', {
		AttributeDefinitions: Match.arrayWith([
			Match.objectLike({ AttributeName: 'PK', AttributeType: 'S' }),
			Match.objectLike({ AttributeName: 'SK', AttributeType: 'S' }),
		]),
		KeySchema: Match.arrayWith([
			Match.objectLike({ AttributeName: 'PK', KeyType: 'HASH' }),
			Match.objectLike({ AttributeName: 'SK', KeyType: 'RANGE' }),
		]),
		BillingMode: 'PAY_PER_REQUEST',
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
		TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
	});
	synthesized.hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Retain',
		UpdateReplacePolicy: 'Retain',
		Properties: Match.objectLike({
			TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
		}),
	});
});

test('break-glass role is assumable only by the configured principal and scoped to the lock partition key', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::IAM::Role', {
		AssumeRolePolicyDocument: Match.objectLike({
			Statement: Match.arrayWith([
				Match.objectLike({
					Effect: 'Allow',
					Action: 'sts:AssumeRole',
					Principal: { AWS: BREAK_GLASS_PRINCIPAL_ARN },
				}),
			]),
		}),
	});

	const policies = synthesized.findResources('AWS::IAM::Policy');
	const breakGlassPolicies = Object.values(policies).filter(resource =>
		JSON.stringify(resource).includes('ArchiveLockBreakGlassRole'));
	expect(breakGlassPolicies.length).toBeGreaterThan(0);
	const serialized = JSON.stringify(breakGlassPolicies);
	expect(serialized).toContain('states:DescribeExecution');
	// The break-glass role must never gain the read/write access the archive function
	// itself has -- it is a narrow, human-assumable delete-only override.
	expect(serialized).not.toContain('dynamodb:PutItem');
	expect(serialized).not.toContain('dynamodb:UpdateItem');
});

test('break-glass DeleteItem statement is exactly scoped to the lock partition key, not a broader match', () => {
	const synthesized = template();
	// A plain substring check (e.g. `.toContain('dynamodb:LeadingKeys')`) would still pass
	// if the condition operator were loosened to ForAllValues:StringLike with values
	// ['LOCK#monthly-archive', '*'] -- which would authorize deleting RUN items too. Match
	// the whole statement exactly: exact resource, exact condition operator, exact (single)
	// leading-key value.
	synthesized.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: Match.objectLike({
			Statement: Match.arrayWith([
				Match.exact({
					Effect: 'Allow',
					Action: 'dynamodb:DeleteItem',
					Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ArchiveCoordinationTable'), 'Arn'] },
					Condition: {
						'ForAllValues:StringEquals': {
							'dynamodb:LeadingKeys': ['LOCK#monthly-archive'],
						},
					},
				}),
			]),
		}),
	});
});

test('failure-reconciliation EventBridge rule dispatches RECONCILE_FAILURE with a dead-letter queue', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::Events::Rule', {
		Targets: Match.arrayWith([
			Match.objectLike({
				DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
				RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 3 }),
				InputTransformer: Match.objectLike({
					InputTemplate: Match.stringLikeRegexp('RECONCILE_FAILURE'),
				}),
			}),
		]),
	});
	synthesized.resourceCountIs('AWS::SQS::Queue', 1);
	synthesized.hasResourceProperties('AWS::CloudWatch::Alarm', {
		Namespace: 'AWS/SQS',
		MetricName: 'ApproximateNumberOfMessagesVisible',
		ComparisonOperator: 'GreaterThanOrEqualToThreshold',
	});
});

test('archive function has its own async-invoke failure destination, not just the EventBridge target DLQ', () => {
	const synthesized = template();
	// EventBridge invokes this Lambda target asynchronously: once it hands the invocation
	// to Lambda, EventBridge's own retry/DLQ (asserted above) considers delivery done and
	// never observes whether the function itself throws. Only a Lambda-level async
	// invocation failure destination catches that -- this asserts it exists and points at
	// the same reconciliation DLQ.
	synthesized.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
		FunctionName: { Ref: Match.stringLikeRegexp('^MonthlyLogArchiveFunction') },
		DestinationConfig: Match.objectLike({
			OnFailure: Match.objectLike({
				Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('^MonthlyArchiveReconciliationDLQ'), 'Arn'] },
			}),
		}),
	});
});

test('the failure Catch path no longer has a standalone SnsPublish task', () => {
	const synthesized = template();
	const stateMachines = synthesized.findResources('AWS::StepFunctions::StateMachine');
	const definition = JSON.stringify(stateMachines);
	expect(definition).toContain('RECONCILE_FAILURE');
	expect(definition).not.toContain('EmailMonthlyArchiveFailure');
	expect(definition).not.toContain('"action":"FAIL"');
	expect(definition).not.toContain('"action":"RELEASE_LOCK"');
});

test('ingestion REST API is regional, has one POST method requiring an API key, and access logging', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::ApiGateway::RestApi', {
		Name: 'particle-ingestion-api',
		EndpointConfiguration: { Types: ['REGIONAL'] },
	});
	synthesized.hasResourceProperties('AWS::ApiGateway::Method', {
		HttpMethod: 'POST',
		ApiKeyRequired: true,
	});
	synthesized.hasResourceProperties('AWS::ApiGateway::Stage', {
		StageName: 'prod',
		AccessLogSetting: Match.objectLike({
			DestinationArn: Match.anyValue(),
			Format: Match.stringLikeRegexp('requestId'),
		}),
	});
	synthesized.hasResourceProperties('AWS::Logs::LogGroup', {
		RetentionInDays: 30,
	});
});

test('custom domain has exactly one base path mapping, to the ingestion REST API', () => {
	const synthesized = template();
	synthesized.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
	synthesized.hasResourceProperties('AWS::ApiGateway::BasePathMapping', {
		DomainName: Match.anyValue(),
		RestApiId: { Ref: Match.stringLikeRegexp('^IngestionRestApi') },
	});
});

test('registry-driven per-consumer resources: one API key and usage plan per registered consumer, throttled per its own numbers', () => {
	const synthesized = template();
	synthesized.resourceCountIs('AWS::ApiGateway::ApiKey', 2);
	synthesized.hasResourceProperties('AWS::ApiGateway::ApiKey', {
		Name: 'particle-ingestion-particle-cloud-webhook',
		Enabled: true,
	});
	synthesized.hasResourceProperties('AWS::ApiGateway::ApiKey', {
		Name: 'particle-ingestion-serial-forwarder',
		Enabled: true,
	});
	synthesized.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
		UsagePlanName: 'particle-ingestion-particle-cloud-webhook',
		Throttle: { RateLimit: 100, BurstLimit: 500 },
	});
	synthesized.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
		UsagePlanName: 'particle-ingestion-serial-forwarder',
		Throttle: { RateLimit: 10, BurstLimit: 50 },
	});
	synthesized.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 2);
});

test('ingestion function IAM policy grants per-consumer secretsmanager:GetSecretValue scoped to each consumer secret ARN, never a wildcard', () => {
	const synthesized = template();
	const policies = synthesized.findResources('AWS::IAM::Policy');
	const ingestionPolicies = Object.values(policies).filter(resource =>
		JSON.stringify(resource).includes('ParticleLogIngestionFunction'));
	const serialized = JSON.stringify(ingestionPolicies);
	// Both consumer secrets show up as GetSecretValue targets ...
	expect(serialized).toContain('secretsmanager:GetSecretValue');
	expect(serialized).toContain('particle-cloud-webhook/webhook-secret');
	expect(serialized).toContain('serial-forwarder/webhook-secret');
	// ... but never as a prefix/wildcard grant across the whole consumers/ namespace -- a
	// deliberate, scoped-per-secret reversal of PR #35's "zero secretsmanager:* on this
	// role" property, not an accidental broadening back to it.
	expect(serialized).not.toContain('ingestion/consumers/*');
});

test('ingestion function gets one INGESTION_API_KEY_ID_<CONSUMER> env var per registered consumer, matching the registry naming convention', () => {
	const synthesized = template();
	synthesized.hasResourceProperties('AWS::Lambda::Function', {
		Environment: {
			Variables: Match.objectLike({
				INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK: Match.anyValue(),
				INGESTION_API_KEY_ID_SERIAL_FORWARDER: Match.anyValue(),
				QUERY_API_SHARED_SECRET: Match.anyValue(),
			}),
		},
	});
});
