/**
 * DynamoDB current-state index for Phase 3A fleet intelligence.
 *
 * This table is intentionally separate from the event history table so fleet
 * endpoints can query one compact item per device by projectId without scanning
 * historical telemetry.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeviceCurrentState, DeviceHealthStatus, NormalizedEventFields, ParsedEvent, ParticleWebhook } from '../types';
import { ParticleDeviceNameResolution } from '../integrations/particle-api';
declare const ddb: DynamoDBDocumentClient;
export declare function updateDeviceCurrentState(tableName: string, deviceId: string, eventTime: string, eventName: string, body: ParticleWebhook, parsed: ParsedEvent, normalized?: NormalizedEventFields, options?: UpdateDeviceCurrentStateOptions): Promise<void>;
export interface UpdateDeviceCurrentStateOptions {
    previous?: DeviceCurrentState | null;
    deviceNameResolution?: ParticleDeviceNameResolution | null;
}
export declare function getDeviceCurrentState(tableName: string, projectId: string, deviceId: string): Promise<DeviceCurrentState | null>;
export interface DeviceStatusLedgerSnapshot {
    updatedAt: string;
    fetchedAt: string;
    sizeBytes?: number;
    data: Record<string, unknown>;
}
export type ProjectedLedger = 'deviceStatus' | 'productDefaults' | 'deviceSettings';
export declare function updateDeviceStatusLedgerSnapshot(tableName: string, projectId: string, deviceId: string, snapshot: DeviceStatusLedgerSnapshot): Promise<'updated' | 'stale'>;
export declare function updateProductDefaultsLedgerSnapshot(tableName: string, projectId: string, deviceId: string, snapshot: DeviceStatusLedgerSnapshot): Promise<'updated' | 'stale'>;
export declare function updateDeviceSettingsLedgerSnapshot(tableName: string, projectId: string, deviceId: string, snapshot: DeviceStatusLedgerSnapshot): Promise<'updated' | 'stale'>;
export declare function projectMissingDeviceSettingsLedger(tableName: string, projectId: string, deviceId: string, fetchedAt: string): Promise<'updated' | 'stale'>;
export declare function queryDeviceCurrentStates(tableName: string, projectId: string, limit?: number): Promise<DeviceCurrentState[]>;
interface BuildStateInput {
    projectId: string;
    deviceId: string;
    eventTime: string;
    eventName: string;
    body: ParticleWebhook;
    parsed: ParsedEvent;
    normalized?: NormalizedEventFields;
    previous: DeviceCurrentState | null;
    deviceNameResolution?: ParticleDeviceNameResolution | null;
    updatedAt: string;
}
declare function buildCurrentState(input: BuildStateInput): DeviceCurrentState;
declare function determineHealthStatus(state: Partial<DeviceCurrentState>, resetIncreased: boolean): DeviceHealthStatus;
export { ddb, buildCurrentState, determineHealthStatus };
//# sourceMappingURL=current-state.d.ts.map