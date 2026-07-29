/**
 * DynamoDB event history for Phase 4 append-only event persistence.
 *
 * Each item is a new PutCommand write (never an update), matching the
 * log-events table's structurally safe write pattern.
 *
 * Table key schema:
 *   Partition key: deviceId  (STRING)
 *   Sort key:      eventTime (STRING) — stores "{isoTimestamp}#{eventType}#{uniqueId}"
 *                  where uniqueId is the normalized eventId (stable per report) or a
 *                  random UUID fallback, guaranteeing uniqueness even when multiple
 *                  reports share the same timestamp and event type.
 */

import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CurrentStateAnomaly, DeviceCurrentState, NormalizedEventFields } from '../types';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

export type EventHistoryEventType =
  | 'ANOMALY'
  | 'FIRMWARE_UPDATE'
  | 'BATTERY_CRITICAL'
  | 'DEVICE_RECOVERED'
  | 'LEDGER_SYNC_FAILED';

export interface EventHistoryItem {
  deviceId: string;
  /** Sort key value: "{isoTimestamp}#{eventType}#{uniqueId}" */
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
 *   DEVICE_RECOVERED  — previous state was an offline candidate and current report is newer
 *   LEDGER_SYNC_FAILED — ledger refresh returned a failure
 *
 * All writes are issued concurrently via Promise.all.
 */
export async function writeIngestionEventHistory(
  ctx: IngestionEventHistoryContext
): Promise<void> {
  const writes: Promise<void>[] = [];

  // Stable per-report unique ID, used as the collision-resistant sort-key suffix.
  // Falls back to a random UUID when normalized fields are unavailable.
  const uniqueId = ctx.normalized?.eventId ?? randomUUID();

  // Compute effective state: take normalized value, fall back to previous.
  // Mirrors mergePreviousMetrics() in current-state.ts.
  const effectiveBattery = ctx.normalized?.battery ?? ctx.previousState?.battery;
  const effectiveConnectTime = ctx.normalized?.connectTime ?? ctx.previousState?.connectTime;
  const effectiveAlertCount = ctx.normalized?.alertCount ?? ctx.previousState?.alertCount;
  const effectiveSeverity = ctx.normalized?.severity;
  const effectiveWatchdog = ctx.normalized?.watchdogDetected ?? ctx.previousState?.watchdogDetected;
  const effectiveReconnect = ctx.normalized?.reconnectDetected ?? ctx.previousState?.reconnectDetected;
  const effectiveReset = ctx.normalized?.resetDetected ?? ctx.previousState?.resetDetected;

  // Compute anomalies — mirrors buildAnomalies() in current-state.ts.
  const anomalies = computeAnomalies({
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
    writes.push(writeEventHistory(ctx.tableName, {
      deviceId: ctx.deviceId,
      eventTime: `${ctx.publishedAt}#ANOMALY#${uniqueId}`,
      eventType: 'ANOMALY',
      reportTime: ctx.publishedAt,
      anomalies,
      anomalyCount: anomalies.length,
    }));
  }

  // FIRMWARE_UPDATE — fires when firmware version differs from previous state.
  const newFwVersion = ctx.normalized?.fwVersion;
  const prevFwVersion = ctx.previousState?.fwVersion;
  if (newFwVersion && prevFwVersion && newFwVersion !== prevFwVersion) {
    writes.push(writeEventHistory(ctx.tableName, {
      deviceId: ctx.deviceId,
      eventTime: `${ctx.publishedAt}#FIRMWARE_UPDATE#${uniqueId}`,
      eventType: 'FIRMWARE_UPDATE',
      reportTime: ctx.publishedAt,
      fromFwVersion: prevFwVersion,
      toFwVersion: newFwVersion,
    }));
  }

  // BATTERY_CRITICAL — fires only on the transition into critical (< 20%).
  // Skips if the previous state was already below 20% to avoid firing on every
  // report from a device that has been sitting at a low charge for days.
  const prevBattery = ctx.previousState?.battery;
  const wasAlreadyCritical = prevBattery !== undefined && prevBattery < 20;
  if (effectiveBattery !== undefined && effectiveBattery < 20 && !wasAlreadyCritical) {
    writes.push(writeEventHistory(ctx.tableName, {
      deviceId: ctx.deviceId,
      eventTime: `${ctx.publishedAt}#BATTERY_CRITICAL#${uniqueId}`,
      eventType: 'BATTERY_CRITICAL',
      reportTime: ctx.publishedAt,
      batteryLevel: effectiveBattery,
    }));
  }

  // DEVICE_RECOVERED — fires when the previous state was an offline candidate
  // and the current report carries a newer timestamp, confirming the device
  // has actually come back online.
  if (
    ctx.previousState?.offlineCandidate === true &&
    ctx.publishedAt > ctx.previousState.lastEventTime
  ) {
    writes.push(writeEventHistory(ctx.tableName, {
      deviceId: ctx.deviceId,
      eventTime: `${ctx.publishedAt}#DEVICE_RECOVERED#${uniqueId}`,
      eventType: 'DEVICE_RECOVERED',
      reportTime: ctx.publishedAt,
    }));
  }

  // LEDGER_SYNC_FAILED — fires when a ledger refresh failure was signalled.
  if (ctx.ledgerSyncFailure) {
    const item: EventHistoryItem = {
      deviceId: ctx.deviceId,
      eventTime: `${ctx.publishedAt}#LEDGER_SYNC_FAILED#${uniqueId}`,
      eventType: 'LEDGER_SYNC_FAILED',
      reportTime: ctx.publishedAt,
    };
    if (ctx.ledgerSyncFailure.errorKind !== undefined) {
      item.errorKind = ctx.ledgerSyncFailure.errorKind;
    }
    if (ctx.ledgerSyncFailure.httpStatus !== undefined) {
      item.httpStatus = ctx.ledgerSyncFailure.httpStatus;
    }
    writes.push(writeEventHistory(ctx.tableName, item));
  }

  await Promise.all(writes);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AnomalyState {
  battery?: number;
  connectTime?: number;
  alertCount?: number;
  severity?: string | null;
  watchdogDetected?: boolean;
  reconnectDetected?: boolean;
  resetDetected?: boolean;
}

/**
 * Derive anomalies from the effective device state.
 * Mirrors buildAnomalies() in storage/current-state.ts (no import needed).
 */
function computeAnomalies(state: AnomalyState): CurrentStateAnomaly[] {
  const anomalies: CurrentStateAnomaly[] = [];

  if (state.battery !== undefined && state.battery < 20) {
    anomalies.push({ severity: 'high', type: 'critical_battery', message: 'Battery below 20%' });
  } else if (state.battery !== undefined && state.battery < 30) {
    anomalies.push({ severity: 'medium', type: 'low_battery', message: 'Battery below 30%' });
  }

  if (state.connectTime !== undefined && state.connectTime > 300) {
    anomalies.push({ severity: 'high', type: 'very_high_connect_time', message: 'Connect time exceeded 300 seconds' });
  } else if (state.connectTime !== undefined && state.connectTime > 180) {
    anomalies.push({ severity: 'medium', type: 'high_connect_time', message: 'Connect time exceeded 180 seconds' });
  }

  if (state.alertCount !== undefined && state.alertCount > 0) {
    anomalies.push({ severity: 'high', type: 'active_alerts', message: 'Active alert count is non-zero' });
  }

  if (state.severity === 'ERROR') {
    anomalies.push({ severity: 'high', type: 'serial_error', message: 'Latest serial event is ERROR severity' });
  } else if (state.severity === 'WARN') {
    anomalies.push({ severity: 'medium', type: 'serial_warning', message: 'Latest serial event is WARN severity' });
  }

  if (state.watchdogDetected) {
    anomalies.push({ severity: 'high', type: 'serial_watchdog', message: 'Serial log indicates watchdog activity' });
  }

  if (state.reconnectDetected) {
    anomalies.push({ severity: 'medium', type: 'serial_reconnect', message: 'Serial log indicates reconnect or retry activity' });
  }

  if (state.resetDetected) {
    anomalies.push({ severity: 'medium', type: 'serial_reset', message: 'Serial log indicates reset, reboot, or panic activity' });
  }

  return anomalies.slice(0, 10);
}

export { ddb };
