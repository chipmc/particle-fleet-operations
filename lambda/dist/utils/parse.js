"use strict";
/**
 * Parsing utilities for Particle webhook events
 *
 * Phase 1: Extract current parsing logic (exact behavior preservation)
 * Phase 2: Add normalization functions (scaffolded below)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEventBody = parseEventBody;
exports.extractDeviceId = extractDeviceId;
exports.extractTimestamp = extractTimestamp;
exports.extractEventName = extractEventName;
exports.safeParseData = safeParseData;
exports.buildParsedEvent = buildParsedEvent;
exports.generateS3Key = generateS3Key;
exports.normalizeEvent = normalizeEvent;
exports.parseSeverity = parseSeverity;
exports.parseResetCause = parseResetCause;
exports.parseQueueDepth = parseQueueDepth;
exports.parseNetworkState = parseNetworkState;
/**
 * Parse raw request body into ParticleWebhook object
 * Preserves exact current behavior including error handling
 */
function parseEventBody(rawBody) {
    try {
        return JSON.parse(rawBody || '{}');
    }
    catch (err) {
        throw new Error('Invalid JSON body');
    }
}
/**
 * Extract device ID from webhook with fallback logic
 * Preserves exact current priority: coreid -> deviceId -> "unknown"
 */
function extractDeviceId(body) {
    return body.coreid || body.deviceId || 'unknown';
}
/**
 * Extract timestamp from webhook with fallback logic
 * Preserves exact current priority: published_at -> timestamp -> now
 */
function extractTimestamp(body) {
    return body.published_at || body.timestamp || new Date().toISOString();
}
/**
 * Extract event name from webhook
 * Preserves exact current fallback
 */
function extractEventName(body) {
    return body.event || 'unknown';
}
/**
 * Safely parse data field which may be JSON string or plain text
 * Preserves exact current behavior: try parse, fallback to raw
 */
function safeParseData(data) {
    if (typeof data !== 'string') {
        return data;
    }
    try {
        return JSON.parse(data);
    }
    catch {
        // Particle data may be plain text; keep it as-is
        return data;
    }
}
/**
 * Build the parsed event record
 * Preserves exact current "safeRecord" structure
 */
function buildParsedEvent(body, userAgent, sourceIp) {
    const eventName = extractEventName(body);
    const deviceId = extractDeviceId(body);
    const publishedAt = extractTimestamp(body);
    const receivedAt = new Date().toISOString();
    const parsedData = safeParseData(body.data);
    return {
        eventName,
        deviceId,
        publishedAt,
        receivedAt,
        public: body.public,
        fw_version: body.fw_version,
        data: parsedData,
        userAgent,
        sourceIp,
    };
}
/**
 * Generate S3 key for raw event storage
 * Preserves exact current path format:
 * particle-events/YYYY-MM-DD/{eventName}/{deviceId}/timestamp.json
 */
function generateS3Key(eventName, deviceId, publishedAt) {
    const datePrefix = publishedAt.substring(0, 10);
    const safeTimestamp = publishedAt.replace(/[:.]/g, '-');
    return `particle-events/${datePrefix}/${eventName}/${deviceId}/${safeTimestamp}.json`;
}
// ============================================================================
// Phase 2 Functions (Scaffolded - Not Implemented Yet)
// ============================================================================
/**
 * Normalize raw event into canonical envelope
 *
 * Phase 2 implementation will:
 * - Map eventName -> stable eventType
 * - Add schemaVersion, eventVersion
 * - Classify plane (telemetry|forensic|serial)
 * - Extract enrichment fields (severity, resetCause, etc.)
 *
 * @see docs/contracts/canonical-event-envelope.md
 */
function normalizeEvent( /* params TBD */) {
    throw new Error('normalizeEvent not implemented - Phase 2');
}
/**
 * Parse severity from event data
 *
 * Phase 2 implementation will extract:
 * INFO | WARN | ERROR | TRACE | null
 *
 * Based on:
 * - Log level prefixes in serial logs
 * - Alert event types
 * - Reset/watchdog events (ERROR)
 */
function parseSeverity( /* params TBD */) {
    throw new Error('parseSeverity not implemented - Phase 2');
}
/**
 * Parse reset cause from watchdog/status events
 *
 * Phase 2 implementation will extract reset reason
 * from Particle system events
 */
function parseResetCause( /* params TBD */) {
    throw new Error('parseResetCause not implemented - Phase 2');
}
/**
 * Parse queue depth from status events
 *
 * Phase 2 implementation will extract queue metrics
 * for connectivity diagnostics
 */
function parseQueueDepth( /* params TBD */) {
    throw new Error('parseQueueDepth not implemented - Phase 2');
}
/**
 * Parse network state from connectivity events
 *
 * Phase 2 implementation will extract:
 * - Modem state
 * - Signal strength
 * - Connection status
 */
function parseNetworkState( /* params TBD */) {
    throw new Error('parseNetworkState not implemented - Phase 2');
}
//# sourceMappingURL=parse.js.map