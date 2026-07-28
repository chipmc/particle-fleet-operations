/**
 * Particle Log Ingestion Handler
 * 
 * Extracted from handler.ts to separate ingestion from query logic.
 * Preserves exact Phase 1 + Phase 2A behavior.
 * 
 * This module handles POST /particle/log webhook ingestion.
 */

import { InboundEvent, LambdaResponse, ParticleWebhook } from './types';
import { storeRawEvent } from './storage/s3';
import { indexEvent } from './storage/dynamo';
import { getDeviceCurrentState, updateDeviceCurrentState } from './storage/current-state';
import { writeIngestionEventHistory, LedgerSyncFailureDetail } from './storage/event-history';
import { resolveParticleDeviceName } from './integrations/particle-api';
import { refreshDeviceStatusLedger } from './ledger-refresh';
import {
  parseEventBody,
  buildParsedEvent,
  extractDeviceId,
  extractTimestamp,
  extractEventName,
  generateS3Key,
  safeParseData,
  normalizeEvent,
} from './utils/parse';
import { DeviceCurrentState, NormalizedEventFields } from './types';

/**
 * Handle ingestion of Particle webhook events
 * 
 * Preserves exact current behavior:
 * - 401 if webhook secret missing/invalid
 * - 400 if JSON body invalid
 * - 200 on successful storage
 * - Same logging output
 * 
 * @param event - API Gateway event
 * @returns Lambda response
 */
export async function handleIngestion(event: InboundEvent): Promise<LambdaResponse> {
  // ============================================================================
  // Authentication (Exact Current Behavior)
  // ============================================================================
  
  const expectedSecret = process.env.PARTICLE_WEBHOOK_SECRET;
  const providedSecret =
    event.headers?.['x-particle-webhook-secret'] ||
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
  
  if (event.body === undefined || event.body === null) {
    console.error('Missing request body');
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'missing_body' }),
    };
  }

  let body: ParticleWebhook;
  try {
    body = parseEventBody(event.body);
  } catch (err) {
    console.error('Invalid JSON body', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'invalid_json' }),
    };
  }

  // ============================================================================
  // Extract Event Fields (Exact Current Behavior)
  // ============================================================================
  
  const eventName = extractEventName(body);
  const deviceId = extractDeviceId(body);
  const publishedAt = extractTimestamp(body);
  const parsedData = safeParseData(body.data);

  const parsed = buildParsedEvent(
    body,
    event.requestContext?.http?.userAgent,
    event.requestContext?.http?.sourceIp
  );

  // ============================================================================
  // Storage Operations (Exact Current Behavior)
  // ============================================================================
  
  const s3Key = generateS3Key(eventName, deviceId, publishedAt);

  let normalized: NormalizedEventFields | undefined;
  try {
    normalized = normalizeEvent(body, parsedData, {
      deviceId,
      eventName,
      eventTime: publishedAt,
      s3Key,
    });
  } catch (err) {
    // Enrichment must never prevent the existing raw/index storage path.
    console.warn('Event normalization failed; preserving ingestion', err);
  }

  // Store raw event in S3 (immutable archive)
  await storeRawEvent(
    process.env.RAW_LOGS_BUCKET_NAME!,
    s3Key,
    body,
    parsed
  );

  // Index event in DynamoDB (fast retrieval)
  await indexEvent(
    process.env.LOG_EVENTS_TABLE_NAME!,
    deviceId,
    publishedAt,
    eventName,
    parsed.receivedAt,
    s3Key,
    body,
    parsedData,
    normalized
  );

  const currentStateTableName = process.env.DEVICE_CURRENT_STATE_TABLE_NAME;
  const projectId = normalized?.projectId || body.projectId || 'generalized-core-counter';
  let previousCurrentState: DeviceCurrentState | null = null;
  let ledgerSyncFailure: LedgerSyncFailureDetail | undefined;

  if (currentStateTableName) {
    try {
      previousCurrentState = await getDeviceCurrentState(currentStateTableName, projectId, deviceId);
      const deviceNameResolution = previousCurrentState?.deviceName
        ? null
        : await resolveParticleDeviceName(deviceId);

      await updateDeviceCurrentState(
        currentStateTableName,
        deviceId,
        publishedAt,
        eventName,
        body,
        parsed,
        normalized,
        {
          previous: previousCurrentState,
          deviceNameResolution,
        }
      );
      await refreshDeviceStatusLedger({
        tableName: currentStateTableName,
        projectId,
        deviceId,
        body,
        previous: previousCurrentState,
        onSyncFailed: (detail) => { ledgerSyncFailure = detail; },
      });
      console.log(
        'Phase3A DeviceCurrentState update succeeded',
        JSON.stringify({
          tableName: currentStateTableName,
          projectId,
          deviceId,
          eventName,
          eventTime: publishedAt,
        })
      );
    } catch (err) {
      console.warn(
        'Phase3A DeviceCurrentState update failed; preserving ingestion',
        JSON.stringify({
          tableName: currentStateTableName,
          projectId,
          deviceId,
          eventName,
          eventTime: publishedAt,
        }),
        err
      );
    }
  } else {
    console.warn(
      'Phase3A DeviceCurrentState update skipped; DEVICE_CURRENT_STATE_TABLE_NAME is not set',
      JSON.stringify({
        deviceId,
        eventName,
        eventTime: publishedAt,
      })
    );
  }

  const eventHistoryTableName = process.env.EVENT_HISTORY_TABLE_NAME;
  if (eventHistoryTableName) {
    try {
      await writeIngestionEventHistory({
        tableName: eventHistoryTableName,
        deviceId,
        publishedAt,
        normalized,
        previousState: previousCurrentState,
        ledgerSyncFailure,
      });
    } catch (err) {
      console.warn(
        'Phase4 EventHistory write failed; preserving ingestion',
        JSON.stringify({
          tableName: eventHistoryTableName,
          deviceId,
          eventName,
          eventTime: publishedAt,
        }),
        err
      );
    }
  }

  // ============================================================================
  // Logging and Response (Exact Current Behavior)
  // ============================================================================
  
  console.log(
    'Stored Particle event:',
    JSON.stringify({
      eventName,
      deviceId,
      publishedAt,
      s3Key,
    })
  );

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, stored: true }),
  };
}
