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
import * as path from 'path';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
        PARTICLE_WEBHOOK_SECRET: 'REMOVED_PARTICLE_WEBHOOK_SECRET',
      },
    });

    rawLogsBucket.grantWrite(ingestionFunction);
    logEventsTable.grantWriteData(ingestionFunction);

    const httpApi = new apigwv2.HttpApi(this, 'ParticleLogIngestionApi', {
      apiName: 'particle-log-ingestion-api',
    });

    httpApi.addRoutes({
      path: '/particle/log',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'ParticleLogIngestionIntegration',
        ingestionFunction
      ),
    });

    new cdk.CfnOutput(this, 'ParticleLogIngestionUrl', {
      value: `${httpApi.apiEndpoint}/particle/log`,
    });

    new cdk.CfnOutput(this, 'RawLogsBucketName', {
      value: rawLogsBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'LogEventsTableName', {
      value: logEventsTable.tableName,
    });
  }
}
