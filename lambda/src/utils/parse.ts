/**
 * Parsing utilities for Particle webhook events
 * 
 * Phase 1: Extract current parsing logic (exact behavior preservation)
 * Phase 2: Add normalization functions (scaffolded below)
 */

import { ParticleWebhook, ParsedEvent } from '../types';

/**
 * Parse raw request body into ParticleWebhook object
 * Preserves exact current behavior including error handling
 */
export function parseEventBody(rawBody: string): ParticleWebhook {
  try {
    return JSON.parse(rawBody || '{}');
  } catch (err) {
    throw new Error('Invalid JSON body');
  }
}

/**
 * Extract device ID from webhook with fallback logic
 * Preserves exact current priority: coreid -> deviceId -> "unknown"
 */
export function extractDeviceId(body: ParticleWebhook): string {
  return body.coreid || body.deviceId || 'unknown';
}

/**
 * Extract timestamp from webhook with fallback logic
 * Preserves exact current priority: published_at -> timestamp -> now
 */
export function extractTimestamp(body: ParticleWebhook): string {
  return body.published_at || body.timestamp || new Date().toISOString();
}

/**
 * Extract event name from webhook
 * Preserves exact current fallback
 */
export function extractEventName(body: ParticleWebhook): string {
  return body.event || 'unknown';
}

/**
 * Safely parse data field which may be JSON string or plain text
 * Preserves exact current behavior: try parse, fallback to raw
 */
export function safeParseData(data: any): any {
  if (typeof data !== 'string') {
    return data;
  }
  
  try {
    return JSON.parse(data);
  } catch {
    // Particle data may be plain text; keep it as-is
    return data;
  }
}

/**
 * Build the parsed event record
 * Preserves exact current "safeRecord" structure
 */
export function buildParsedEvent(
  body: ParticleWebhook,
  userAgent?: string,
  sourceIp?: string
): ParsedEvent {
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
export function generateS3Key(
  eventName: string,
  deviceId: string,
  publishedAt: string
): string {
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
export function normalizeEvent(/* params TBD */): any {
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
export function parseSeverity(/* params TBD */): string | null {
  throw new Error('parseSeverity not implemented - Phase 2');
}

/**
 * Parse reset cause from watchdog/status events
 * 
 * Phase 2 implementation will extract reset reason
 * from Particle system events
 */
export function parseResetCause(/* params TBD */): string | null {
  throw new Error('parseResetCause not implemented - Phase 2');
}

/**
 * Parse queue depth from status events
 * 
 * Phase 2 implementation will extract queue metrics
 * for connectivity diagnostics
 */
export function parseQueueDepth(/* params TBD */): number | null {
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
export function parseNetworkState(/* params TBD */): string | null {
  throw new Error('parseNetworkState not implemented - Phase 2');
}
