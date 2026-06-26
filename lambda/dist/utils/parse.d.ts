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
export declare function parseEventBody(rawBody: string): ParticleWebhook;
/**
 * Extract device ID from webhook with fallback logic
 * Preserves exact current priority: coreid -> deviceId -> "unknown"
 */
export declare function extractDeviceId(body: ParticleWebhook): string;
/**
 * Extract timestamp from webhook with fallback logic
 * Preserves exact current priority: published_at -> timestamp -> now
 */
export declare function extractTimestamp(body: ParticleWebhook): string;
/**
 * Extract event name from webhook
 * Preserves exact current fallback
 */
export declare function extractEventName(body: ParticleWebhook): string;
/**
 * Safely parse data field which may be JSON string or plain text
 * Preserves exact current behavior: try parse, fallback to raw
 */
export declare function safeParseData(data: any): any;
/**
 * Build the parsed event record
 * Preserves exact current "safeRecord" structure
 */
export declare function buildParsedEvent(body: ParticleWebhook, userAgent?: string, sourceIp?: string): ParsedEvent;
/**
 * Generate S3 key for raw event storage
 * Preserves exact current path format:
 * particle-events/YYYY-MM-DD/{eventName}/{deviceId}/timestamp.json
 */
export declare function generateS3Key(eventName: string, deviceId: string, publishedAt: string): string;
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
export declare function normalizeEvent(): any;
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
export declare function parseSeverity(): string | null;
/**
 * Parse reset cause from watchdog/status events
 *
 * Phase 2 implementation will extract reset reason
 * from Particle system events
 */
export declare function parseResetCause(): string | null;
/**
 * Parse queue depth from status events
 *
 * Phase 2 implementation will extract queue metrics
 * for connectivity diagnostics
 */
export declare function parseQueueDepth(): number | null;
/**
 * Parse network state from connectivity events
 *
 * Phase 2 implementation will extract:
 * - Modem state
 * - Signal strength
 * - Connection status
 */
export declare function parseNetworkState(): string | null;
//# sourceMappingURL=parse.d.ts.map