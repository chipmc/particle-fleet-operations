/**
 * DynamoDB event history for Phase 4 append-only event persistence.
 *
 * Each item is a new PutCommand write (never an update), matching the
 * log-events table's structurally safe write pattern.
 *
 * Table key schema:
 *   Partition key: deviceId  (STRING)
 *   Sort key:      eventTime (STRING) — stores
 *                  "{isoTimestamp}#{eventType}#{eventIdOrPlaceholder}#{payloadHash}"
 *                  where payloadHash is deterministically derived from the event
 *                  payload so retries stay idempotent while distinct payloads
 *                  sharing the same timestamp/eventId remain append-only.
 */

import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CurrentStateAnomaly, DeviceCurrentState, NormalizedEventFields } from '../types';
import { buildAnomalies } from './current-state';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const DEFAULT_OFFLINE_THRESHOLD_HOURS = 3;
const MISSING_EVENT_ID_COMPONENT = 'no-event-id';

export type EventHistoryEventType =
  | 'ANOMALY'
  | 'FIRMWARE_UPDATE'
  | 'BATTERY_CRITICAL'
  | 'DEVICE_RECOVERED'
  | 'LEDGER_SYNC_FAILED';

export interface EventHistoryItem {
  deviceId: string;
  /** Sort key value: "{isoTimestamp}#{eventType}#{eventIdOrPlaceholder}#{payloadHash}" */
  eventTime: string;
  eventType: EventHistoryEventType;
  /** Pure ISO timestamp of the originating device report. */
  reportTime: string;
  // ANOMALY
  anomalies?: CurrentStateAnomaly[];
  anomalyCount?: number;
  // FIRMWARE_UPDATE
  fromFwVersion?: string;
  toFwVersion?: string;
  // BATTERY_CRITICAL
  batteryLevel?: number;
  // LEDGER_SYNC_FAILED
  errorKind?: string;
  httpStatus?: number;
}

export interface LedgerSyncFailureDetail {
  errorKind?: string;
  httpStatus?: number;
}

/**
 * Write a single EventHistory item using PutCommand (append-only, full-item write).
 */
export async function writeEventHistory(
  tableName: string,
  item: EventHistoryItem
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

export interface IngestionEventHistoryContext {
  tableName: string;
  deviceId: string;
  publishedAt: string;
  evaluatedAt?: string;
  normalized?: NormalizedEventFields;
  previousState: DeviceCurrentState | null;
  ledgerSyncFailure?: LedgerSyncFailureDetail;
}

/**
 * Derive and write all applicable EventHistory items for a single ingestion.
 *
 * Writes up to five event types when their conditions are met:
 *   ANOMALY           — any anomaly detected in the current effective state
 *   FIRMWARE_UPDATE   — firmware version changed from previous report
 *   BATTERY_CRITICAL  — effective battery transitions into below-20% (not already critical)
 *   DEVICE_RECOVERED  — prior telemetry had crossed the offline threshold and this report is fresh again
 *   LEDGER_SYNC_FAILED — ledger refresh returned a failure
 *
 * All writes are issued concurrently via Promise.all.
 */
export async function writeIngestionEventHistory(
  ctx: IngestionEventHistoryContext
): Promise<void> {
  const writes: Promise<void>[] = [];

  // Compute effective state: take normalized value, fall back to previous.
  // Mirrors mergePreviousMetrics() in current-state.ts.
  const effectiveBattery = ctx.normalized?.battery ?? ctx.previousState?.battery;
  const effectiveConnectTime = ctx.normalized?.connectTime ?? ctx.previousState?.connectTime;
  const effectiveAlertCount = ctx.normalized?.alertCount ?? ctx.previousState?.alertCount;
  const effectiveSeverity = ctx.normalized?.severity;
  const effectiveWatchdog = ctx.normalized?.watchdogDetected ?? ctx.previousState?.watchdogDetected;
  const effectiveReconnect = ctx.normalized?.reconnectDetected ?? ctx.previousState?.reconnectDetected;
  const effectiveReset = ctx.normalized?.resetDetected ?? ctx.previousState?.resetDetected;

  const anomalies = buildAnomalies({
    battery: effectiveBattery,
    connectTime: effectiveConnectTime,
    alertCount: effectiveAlertCount,
    severity: effectiveSeverity,
    watchdogDetected: effectiveWatchdog,
    reconnectDetected: effectiveReconnect,
    resetDetected: effectiveReset,
  });

  // ANOMALY — fires when any anomaly is detected in the current effective state.
  if (anomalies.length > 0) {
    writes.push(writeEventHistory(ctx.tableName, createEventHistoryItem(ctx, 'ANOMALY', {
      deviceId: ctx.deviceId,
      reportTime: ctx.publishedAt,
      anomalies,
      anomalyCount: anomalies.length,
    })));
  }

  // FIRMWARE_UPDATE — fires when firmware version differs from previous state.
  const newFwVersion = ctx.normalized?.fwVersion;
  const prevFwVersion = ctx.previousState?.fwVersion;
  if (newFwVersion && prevFwVersion && newFwVersion !== prevFwVersion) {
    writes.push(writeEventHistory(ctx.tableName, createEventHistoryItem(ctx, 'FIRMWARE_UPDATE', {
      deviceId: ctx.deviceId,
      reportTime: ctx.publishedAt,
      fromFwVersion: prevFwVersion,
      toFwVersion: newFwVersion,
    })));
  }

  // BATTERY_CRITICAL — fires only on the transition into critical (< 20%).
  // Skips if the previous state was already below 20% to avoid firing on every
  // report from a device that has been sitting at a low charge for days.
  const prevBattery = ctx.previousState?.battery;
  const wasAlreadyCritical = prevBattery !== undefined && prevBattery < 20;
  if (effectiveBattery !== undefined && effectiveBattery < 20 && !wasAlreadyCritical) {
    writes.push(writeEventHistory(ctx.tableName, createEventHistoryItem(ctx, 'BATTERY_CRITICAL', {
      deviceId: ctx.deviceId,
      reportTime: ctx.publishedAt,
      batteryLevel: effectiveBattery,
    })));
  }

  // DEVICE_RECOVERED — fires only when the previous report had crossed the
  // offline threshold before this one arrived and this new report is itself
  // fresh enough to be considered back online.
  const previousLastEventTime = ctx.previousState?.lastEventTime;
  const currentReportIsFresh = !isOfflineCandidate(
    ctx.publishedAt,
    DEFAULT_OFFLINE_THRESHOLD_HOURS,
    ctx.evaluatedAt ?? new Date().toISOString()
  );
  if (
    previousLastEventTime &&
    ctx.publishedAt > previousLastEventTime &&
    isOfflineCandidate(previousLastEventTime, DEFAULT_OFFLINE_THRESHOLD_HOURS, ctx.publishedAt) &&
    currentReportIsFresh
  ) {
    writes.push(writeEventHistory(ctx.tableName, createEventHistoryItem(ctx, 'DEVICE_RECOVERED', {
      deviceId: ctx.deviceId,
      reportTime: ctx.publishedAt,
    })));
  }

  // LEDGER_SYNC_FAILED — fires when a ledger refresh failure was signalled.
  if (ctx.ledgerSyncFailure) {
    const item = createEventHistoryItem(ctx, 'LEDGER_SYNC_FAILED', {
      deviceId: ctx.deviceId,
      reportTime: ctx.publishedAt,
      ...(ctx.ledgerSyncFailure.errorKind !== undefined && {
        errorKind: ctx.ledgerSyncFailure.errorKind,
      }),
      ...(ctx.ledgerSyncFailure.httpStatus !== undefined && {
        httpStatus: ctx.ledgerSyncFailure.httpStatus,
      }),
    });
    writes.push(writeEventHistory(ctx.tableName, item));
  }

  await Promise.all(writes);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createEventHistoryItem(
  ctx: IngestionEventHistoryContext,
  eventType: EventHistoryEventType,
  item: Omit<EventHistoryItem, 'eventTime' | 'eventType'>
): EventHistoryItem {
  return {
    ...item,
    eventType,
    eventTime: buildEventTime(ctx, eventType, item),
  };
}

function buildEventTime(
  ctx: IngestionEventHistoryContext,
  eventType: EventHistoryEventType,
  item: Omit<EventHistoryItem, 'eventTime' | 'eventType'>
): string {
  const eventIdComponent = ctx.normalized?.eventId ?? MISSING_EVENT_ID_COMPONENT;
  const payloadHash = createHash('sha256')
    .update(stableSerialize({
      normalized: ctx.normalized ?? null,
      item,
    }))
    .digest('hex')
    .slice(0, 16);
  return `${ctx.publishedAt}#${eventType}#${eventIdComponent}#${payloadHash}`;
}

function stableSerialize(value: unknown, depth: number = 0): string {
  if (depth > 50) {
    throw new Error('EventHistory payload exceeded maximum serialization depth');
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? 'null' : stableSerialize(entry, depth + 1)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue, depth + 1)}`).join(',')}}`;
}

function isOfflineCandidate(eventTime: string, thresholdHours: number, now: string): boolean {
  return new Date(eventTime).getTime() < new Date(now).getTime() - thresholdHours * 60 * 60 * 1000;
}

export { ddb };
