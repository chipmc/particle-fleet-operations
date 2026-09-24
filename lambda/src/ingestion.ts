/**
 * Particle Log Ingestion Handler
 * 
 * Extracted from handler.ts to separate ingestion from query logic.
 * Preserves exact Phase 1 + Phase 2A behavior.
 * 
 * This module handles POST /particle/log webhook ingestion.
 */

import { InboundEvent, LambdaResponse, ParticleWebhook } from './types';
import { validateConsumerRequest, buildApiKeyConsumerLookup } from './consumer-auth';
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
  
  const providedSecret =
    event.headers?.['x-particle-webhook-secret'] ||
    event.headers?.['X-Particle-Webhook-Secret'];
  const sourceIp = event.requestContext?.http?.sourceIp;

  // Every request reaches this Lambda via the ingestion REST API custom domain
  // (ingest.seeinsights.com) now that the legacy shared-secret HTTP API route is retired
  // (see docs/security/webhook-secret-rotation-runbook.md) -- API Gateway has already
  // validated the API key itself before invoking this Lambda at all, so event.apiKeyId is
  // always present here. Per-consumer validation: see consumer-auth.ts.
  const result = await validateConsumerRequest(providedSecret, event.apiKeyId, buildApiKeyConsumerLookup(process.env));
  if (result.outcome === 'success') {
    console.info(JSON.stringify({ event: 'ingestion_auth', authResult: 'success', consumerId: result.consumerId, apiKeyId: event.apiKeyId, sourceIp, route: 'POST /particle/log' }));
  } else {
    // Never logs the provided secret value, headers, or hashes -- reason is one of a
    // fixed set of enumerated strings, sufficient to debug without exposing anything.
    console.warn(JSON.stringify({ event: 'ingestion_auth', authResult: 'failure', reason: result.reason, apiKeyId: event.apiKeyId, apiKeyConsumerId: result.apiKeyConsumerId, sourceIp, route: 'POST /particle/log' }));
    return {
      statusCode: result.reason === 'credential_config_unavailable' ? 503 : 401,
      body: JSON.stringify({ ok: false, error: result.reason === 'credential_config_unavailable' ? 'unavailable' : 'unauthorized' }),
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
  const evaluatedAt = new Date().toISOString();
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
        evaluatedAt,
        rawPayload: body,
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
