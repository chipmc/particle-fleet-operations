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
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CurrentStateAnomaly, DeviceCurrentState, NormalizedEventFields } from '../types';
declare const ddb: DynamoDBDocumentClient;
export type EventHistoryEventType = 'ANOMALY' | 'FIRMWARE_UPDATE' | 'BATTERY_CRITICAL' | 'DEVICE_RECOVERED' | 'LEDGER_SYNC_FAILED';
export interface EventHistoryItem {
    deviceId: string;
    /** Sort key value: "{isoTimestamp}#{eventType}#{eventIdOrPlaceholder}#{payloadHash}" */
    eventTime: string;
    eventType: EventHistoryEventType;
    /** Pure ISO timestamp of the originating device report. */
    reportTime: string;
    anomalies?: CurrentStateAnomaly[];
    anomalyCount?: number;
    fromFwVersion?: string;
    toFwVersion?: string;
    batteryLevel?: number;
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
export declare function writeEventHistory(tableName: string, item: EventHistoryItem): Promise<void>;
export interface IngestionEventHistoryContext {
    tableName: string;
    deviceId: string;
    publishedAt: string;
    evaluatedAt?: string;
    rawPayload?: unknown;
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
export declare function writeIngestionEventHistory(ctx: IngestionEventHistoryContext): Promise<void>;
export { ddb };
//# sourceMappingURL=event-history.d.ts.map