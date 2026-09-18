import { ParticleLedgerClient } from './integrations/particle-ledger';
import { LedgerSyncFailureDetail } from './storage/event-history';
import { DeviceCurrentState, ParticleWebhook } from './types';
export type DeviceStatusLedgerRefreshResult = 'disabled' | 'not_allow_listed' | 'event_not_eligible' | 'refresh_cooldown' | 'refresh_inflight' | 'missing_product_id' | 'not_found_or_failed' | 'missing_updated_at' | 'stale' | 'updated';
interface RefreshDeviceStatusLedgerInput {
    tableName: string;
    projectId: string;
    deviceId: string;
    body: ParticleWebhook;
    previous: DeviceCurrentState | null;
    fetchedAt?: Date;
    ledgerClient?: ParticleLedgerClient;
    /** Optional callback invoked when a ledger sync failure occurs. */
    onSyncFailed?: (detail: LedgerSyncFailureDetail) => void | Promise<void>;
}
export declare function refreshDeviceStatusLedger(input: RefreshDeviceStatusLedgerInput): Promise<DeviceStatusLedgerRefreshResult>;
export declare function clearDeviceProductIdCacheForTests(): void;
export {};
//# sourceMappingURL=ledger-refresh.d.ts.map