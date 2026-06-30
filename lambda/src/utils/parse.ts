/**
 * Parsing utilities for Particle webhook events
 * 
 * Phase 1: Extract current parsing logic (exact behavior preservation)
 * Phase 2A: Add best-effort normalization functions
 */

import { createHash } from 'crypto';
import {
  EventPlane,
  EventSeverity,
  NormalizedEventFields,
  ParticleWebhook,
  ParsedEvent,
} from '../types';

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

/**
 * Context already established by the handler before normalization.
 */
export interface NormalizationContext {
  deviceId: string;
  eventName: string;
  eventTime: string;
  s3Key: string;
}

/**
 * Normalize an inbound event into the additive fields stored in DynamoDB.
 * Parsing is deliberately best effort: unknown or malformed payloads still
 * receive the base envelope fields and are classified as telemetry.event.
 */
export function normalizeEvent(
  body: ParticleWebhook,
  parsedData: any,
  context: NormalizationContext
): NormalizedEventFields {
  const data = parsePayloadObject(parsedData);
  const plane = classifyPlane(body, context.eventName);
  const eventType = classifyEventType(body, context.eventName, plane, data);
  const severity = plane === 'serial' ? parseSeverity(body.logLine) : null;
  const sourceType =
    body.sourceType || (plane === 'serial' ? 'serial-forwarder' : 'particle-webhook');

  const normalized: NormalizedEventFields = {
    schemaVersion: '1.0',
    eventId: createEventId(context),
    projectId: body.projectId || 'generalized-core-counter',
    plane,
    eventType,
    eventVersion: '1.0',
    sourceType,
    isSyntheticTime: !body.published_at && !body.timestamp,
    rawRef: {
      s3Key: context.s3Key,
    },
  };

  addString(normalized, 'deviceName', body.deviceName);
  addString(normalized, 'collectorId', body.collectorId);
  if (severity) normalized.severity = severity;

  addNumber(normalized, 'battery', getField(data, body, 'battery'));
  addNumber(normalized, 'connectTime', getField(data, body, 'connecttime'));
  addNumber(normalized, 'resetCount', getField(data, body, 'resets'));
  addNumber(normalized, 'alertCount', getField(data, body, 'alerts'));
  addNumber(normalized, 'occupancy', getField(data, body, 'occupancy'));
  addNumber(normalized, 'dailyOccupancy', getField(data, body, 'dailyoccupancy'));
  addNumber(
    normalized,
    'temperature',
    getField(data, body, 'temp') ?? getField(data, body, 'temperature')
  );

  const fwVersion = getField(data, body, 'fw_version') ?? body.fw_version;
  if (typeof fwVersion === 'string' && fwVersion.length > 0) {
    normalized.fwVersion = fwVersion;
  } else if (typeof fwVersion === 'number' && Number.isFinite(fwVersion)) {
    normalized.fwVersion = String(fwVersion);
  }

  return normalized;
}

/**
 * Parse serial log severity without rejecting unfamiliar log formats.
 */
export function parseSeverity(logLine?: unknown): EventSeverity | null {
  if (typeof logLine !== 'string') return null;
  const match = logLine.match(/\b(TRACE|INFO|WARN|ERROR)\b/i);
  return match ? (match[1].toUpperCase() as EventSeverity) : null;
}

// Reserved enrichment hooks for later Phase 2 work.
export function parseResetCause(/* params TBD */): string | null {
  return null;
}

export function parseQueueDepth(/* params TBD */): number | null {
  return null;
}

export function parseNetworkState(/* params TBD */): string | null {
  return null;
}

function createEventId(context: NormalizationContext): string {
  return createHash('sha256')
    .update([
      context.deviceId,
      context.eventName,
      context.eventTime,
      context.s3Key,
    ].join('\u0000'))
    .digest('hex');
}

function classifyPlane(body: ParticleWebhook, eventName: string): EventPlane {
  if (body.sourceType === 'serial-forwarder' || eventName === 'serialLog') {
    return 'serial';
  }

  if (/(watchdog|status|reset|boot|fault)/i.test(eventName)) {
    return 'forensic';
  }

  return 'telemetry';
}

function classifyEventType(
  body: ParticleWebhook,
  eventName: string,
  plane: EventPlane,
  data: Record<string, any> | null
): string {
  const name = eventName.toLowerCase();
  const sourceEventType = body.eventType?.toUpperCase();
  const lifecycleTypes = new Set([
    'SERIAL_CONNECTED',
    'SERIAL_DISCONNECTED',
    'SERIAL_MISSING',
  ]);

  if (lifecycleTypes.has(eventName.toUpperCase()) ||
      (sourceEventType && lifecycleTypes.has(sourceEventType))) {
    return 'serial.lifecycle';
  }

  if (
    plane === 'serial' &&
    (name === 'seriallog' || name === 'log' || sourceEventType === 'LOG' || !!body.logLine)
  ) {
    return 'serial.log';
  }

  if (name.includes('watchdog')) return 'fault.watchdog';
  if (name.includes('status')) return 'telemetry.status';

  const keys = new Set(Object.keys(data || {}).map(key => key.toLowerCase()));
  if (keys.has('occupancy') || keys.has('dailyoccupancy')) {
    return 'telemetry.occupancy';
  }

  if (
    ['battery', 'connecttime', 'resets', 'alerts', 'temperature', 'temp']
      .some(key => keys.has(key))
  ) {
    return 'telemetry.health';
  }

  return 'telemetry.event';
}

function parsePayloadObject(data: any): Record<string, any> | null {
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  if (typeof data !== 'string') return null;

  const decoded = data
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");

  for (const candidate of [decoded, `{${decoded}`, `{${decoded}}`]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Continue through best-effort candidates.
    }
  }

  return null;
}

function getField(
  data: Record<string, any> | null,
  body: ParticleWebhook,
  field: string
): unknown {
  const dataEntry = data
    ? Object.entries(data).find(([key]) => key.toLowerCase() === field.toLowerCase())
    : undefined;
  if (dataEntry) return dataEntry[1];

  const bodyEntry = Object.entries(body).find(
    ([key]) => key.toLowerCase() === field.toLowerCase()
  );
  return bodyEntry?.[1];
}

function addNumber(
  target: NormalizedEventFields,
  field:
    | 'battery'
    | 'connectTime'
    | 'resetCount'
    | 'alertCount'
    | 'occupancy'
    | 'dailyOccupancy'
    | 'temperature',
  value: unknown
): void {
  if (value === null || value === undefined || value === '') return;
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numberValue)) target[field] = numberValue;
}

function addString(
  target: NormalizedEventFields,
  field: 'deviceName' | 'collectorId',
  value: unknown
): void {
  if (typeof value === 'string' && value.length > 0) target[field] = value;
}
