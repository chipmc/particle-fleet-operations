"use strict";
/**
 * Particle Log Ingestion Lambda
 *
 * Main handler for webhook ingestion from:
 * - Particle Product Webhooks
 * - Raspberry Pi Serial Forwarder
 *
 * Phase 1: Extracted from inline CDK code (exact behavior preservation)
 * Phase 2: Will add normalization and enrichment pipeline
 *
 * Architecture:
 * - Webhook auth via X-Particle-Webhook-Secret header
 * - Raw event immutable storage in S3
 * - Fast indexed retrieval via DynamoDB
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const s3_1 = require("./storage/s3");
const dynamo_1 = require("./storage/dynamo");
const parse_1 = require("./utils/parse");
/**
 * Main Lambda handler
 *
 * Preserves exact current behavior:
 * - 401 if webhook secret missing/invalid
 * - 400 if JSON body invalid
 * - 200 on successful storage
 * - Same logging output
 */
async function handler(event) {
    // ============================================================================
    // Authentication (Exact Current Behavior)
    // ============================================================================
    const expectedSecret = process.env.PARTICLE_WEBHOOK_SECRET;
    const providedSecret = event.headers?.['x-particle-webhook-secret'] ||
        event.headers?.['X-Particle-Webhook-Secret'];
    if (!expectedSecret || providedSecret !== expectedSecret) {
        console.warn('Unauthorized webhook attempt');
        return {
            statusCode: 401,
            body: JSON.stringify({ ok: false, error: 'unauthorized' }),
        };
    }
    // ============================================================================
    // Parse Request Body (Exact Current Behavior)
    // ============================================================================
    let body;
    try {
        body = (0, parse_1.parseEventBody)(event.body);
    }
    catch (err) {
        console.error('Invalid JSON body', err);
        return {
            statusCode: 400,
            body: JSON.stringify({ ok: false, error: 'invalid_json' }),
        };
    }
    // ============================================================================
    // Extract Event Fields (Exact Current Behavior)
    // ============================================================================
    const eventName = (0, parse_1.extractEventName)(body);
    const deviceId = (0, parse_1.extractDeviceId)(body);
    const publishedAt = (0, parse_1.extractTimestamp)(body);
    const parsedData = (0, parse_1.safeParseData)(body.data);
    const parsed = (0, parse_1.buildParsedEvent)(body, event.requestContext?.http?.userAgent, event.requestContext?.http?.sourceIp);
    // ============================================================================
    // Storage Operations (Exact Current Behavior)
    // ============================================================================
    const s3Key = (0, parse_1.generateS3Key)(eventName, deviceId, publishedAt);
    // Store raw event in S3 (immutable archive)
    await (0, s3_1.storeRawEvent)(process.env.RAW_LOGS_BUCKET_NAME, s3Key, body, parsed);
    // Index event in DynamoDB (fast retrieval)
    await (0, dynamo_1.indexEvent)(process.env.LOG_EVENTS_TABLE_NAME, deviceId, publishedAt, eventName, parsed.receivedAt, s3Key, body, parsedData);
    // ============================================================================
    // Logging and Response (Exact Current Behavior)
    // ============================================================================
    console.log('Stored Particle event:', JSON.stringify({
        eventName,
        deviceId,
        publishedAt,
        s3Key,
    }));
    return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, stored: true }),
    };
}
//# sourceMappingURL=handler.js.map