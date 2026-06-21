import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

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

    const ingestionFunction = new lambda.Function(this, 'ParticleLogIngestionFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      code: lambda.Code.fromInline(`
        const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
        const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
        const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

        const s3 = new S3Client({});
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

        exports.handler = async function(event) {
          const expectedSecret = process.env.PARTICLE_WEBHOOK_SECRET;
          const providedSecret =
            event.headers?.["x-particle-webhook-secret"] ||
            event.headers?.["X-Particle-Webhook-Secret"];

          if (!expectedSecret || providedSecret !== expectedSecret) {
            console.warn("Unauthorized webhook attempt");
            return {
              statusCode: 401,
              body: JSON.stringify({ ok: false, error: "unauthorized" })
            };
          }

          let body;
          try {
            body = JSON.parse(event.body || "{}");
          } catch (err) {
            console.error("Invalid JSON body", err);
            return {
              statusCode: 400,
              body: JSON.stringify({ ok: false, error: "invalid_json" })
            };
          }

          let parsedData = body.data;
          try {
            parsedData = JSON.parse(body.data);
          } catch {
            // Particle data may be plain text; keep it as-is
          }

          const eventName = body.event || "unknown";
          const deviceId =
            body.coreid ||
            body.deviceId ||
            "unknown";
          const publishedAt =
            body.published_at ||
            body.timestamp ||
            new Date().toISOString();
          const receivedAt = new Date().toISOString();

          const safeRecord = {
            eventName,
            deviceId,
            publishedAt,
            receivedAt,
            public: body.public,
            fw_version: body.fw_version,
            data: parsedData,
            userAgent: event.requestContext?.http?.userAgent,
            sourceIp: event.requestContext?.http?.sourceIp
          };

          const datePrefix = publishedAt.substring(0, 10);
          const s3Key = \`particle-events/\${datePrefix}/\${eventName}/\${deviceId}/\${publishedAt.replace(/[:.]/g, "-")}.json\`;

          await s3.send(new PutObjectCommand({
            Bucket: process.env.RAW_LOGS_BUCKET_NAME,
            Key: s3Key,
            Body: JSON.stringify({
              particle: body,
              parsed: safeRecord
            }, null, 2),
            ContentType: "application/json"
          }));

          await ddb.send(new PutCommand({
            TableName: process.env.LOG_EVENTS_TABLE_NAME,
            Item: {
              deviceId,
              eventTime: publishedAt,
              eventName,
              receivedAt,
              s3Key,
              fw_version: body.fw_version,
              public: body.public,
              dataType: typeof parsedData,

              sourceType: body.sourceType,
              collectorId: body.collectorId,
              transport: body.transport,
              eventType: body.eventType,
              deviceName: body.deviceName,
              logLine: body.logLine
            }
          }));

          console.log("Stored Particle event:", JSON.stringify({
            eventName,
            deviceId,
            publishedAt,
            s3Key
          }));

          return {
            statusCode: 200,
            body: JSON.stringify({ ok: true, stored: true })
          };
        };
      `),      
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
