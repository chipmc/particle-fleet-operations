"use strict";
/**
 * DynamoDB operations for event indexing
 *
 * Preserves exact current behavior:
 * - Fast indexed retrieval by deviceId + eventTime
 * - Current schema (no normalization yet)
 * - Extended fields from serial forwarder
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ddb = void 0;
exports.indexEvent = indexEvent;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
// Initialize client at module level to allow mocking
const client = new client_dynamodb_1.DynamoDBClient({});
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(client);
exports.ddb = ddb;
/**
 * Index event in DynamoDB for fast retrieval
 *
 * Preserves exact current schema:
 * - Partition key: deviceId
 * - Sort key: eventTime
 * - Includes s3Key reference for raw data replay
 *
 * @param tableName - DynamoDB table name from environment
 * @param deviceId - Device identifier
 * @param eventTime - Event timestamp (published_at)
 * @param eventName - Event name
 * @param receivedAt - Ingestion timestamp
 * @param s3Key - S3 key for raw event
 * @param body - Original webhook body (for extended fields)
 * @param parsedData - Parsed data (for dataType)
 */
async function indexEvent(tableName, deviceId, eventTime, eventName, receivedAt, s3Key, body, parsedData) {
    const item = {
        deviceId,
        eventTime,
        eventName,
        receivedAt,
        s3Key,
        fw_version: body.fw_version,
        public: body.public,
        dataType: typeof parsedData,
        // Extended fields from serial forwarder
        sourceType: body.sourceType,
        collectorId: body.collectorId,
        transport: body.transport,
        eventType: body.eventType,
        deviceName: body.deviceName,
        logLine: body.logLine,
    };
    await ddb.send(new lib_dynamodb_1.PutCommand({
        TableName: tableName,
        Item: item,
    }));
}
//# sourceMappingURL=dynamo.js.map