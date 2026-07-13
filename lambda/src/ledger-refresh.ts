import { resolveParticleDeviceProductId } from './integrations/particle-api';
import { ParticleLedgerClient, ParticleLedgerNames } from './integrations/particle-ledger';
import { updateDeviceStatusLedgerSnapshot } from './storage/current-state';
import { DeviceCurrentState, ParticleWebhook } from './types';

export type DeviceStatusLedgerRefreshResult =
  | 'disabled'
  | 'not_allow_listed'
  | 'event_not_eligible'
  | 'refresh_cooldown'
  | 'missing_product_id'
  | 'not_found_or_failed'
  | 'missing_updated_at'
  | 'stale'
  | 'updated';

interface RefreshDeviceStatusLedgerInput {
  tableName: string;
  projectId: string;
  deviceId: string;
  body: ParticleWebhook;
  previous: DeviceCurrentState | null;
  fetchedAt?: Date;
  ledgerClient?: ParticleLedgerClient;
}

const productIdByDeviceId = new Map<string, string>();
const lastRefreshAttemptAtByDeviceId = new Map<string, number>();
const inFlightRefreshByDeviceId = new Map<string, Promise<DeviceStatusLedgerRefreshResult>>();

export async function refreshDeviceStatusLedger(
  input: RefreshDeviceStatusLedgerInput
): Promise<DeviceStatusLedgerRefreshResult> {
  if (!isLedgerRefreshEnabled()) {
    return 'disabled';
  }

  if (!isDeviceAllowListed(input.deviceId)) {
    return 'not_allow_listed';
  }

  if (!isEventNameEligible(input.body.event || 'unknown')) {
    return 'event_not_eligible';
  }

  const inFlightRefresh = inFlightRefreshByDeviceId.get(input.deviceId);
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  const nowMs = (input.fetchedAt || new Date()).getTime();
  const lastRefreshAttemptAt = lastRefreshAttemptAtByDeviceId.get(input.deviceId);
  if (lastRefreshAttemptAt !== undefined && nowMs - lastRefreshAttemptAt < getRefreshMinIntervalMs()) {
    return 'refresh_cooldown';
  }

  lastRefreshAttemptAtByDeviceId.set(input.deviceId, nowMs);

  const refreshPromise = executeDeviceStatusLedgerRefresh(input);
  inFlightRefreshByDeviceId.set(input.deviceId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (inFlightRefreshByDeviceId.get(input.deviceId) === refreshPromise) {
      inFlightRefreshByDeviceId.delete(input.deviceId);
    }
  }
}

async function executeDeviceStatusLedgerRefresh(
  input: RefreshDeviceStatusLedgerInput
): Promise<DeviceStatusLedgerRefreshResult> {
  try {
    const productId = await resolveProductId(input.body, input.deviceId, input.fetchedAt);
    if (!productId) {
      return 'missing_product_id';
    }

    const ledgerClient = input.ledgerClient || new ParticleLedgerClient();
    const ledgerResult = await ledgerClient.getDeviceStatus(productId, input.deviceId);

    if (!ledgerResult.ok) {
      logLedgerRefresh({
        deviceId: input.deviceId,
        productId,
        result: 'failed',
        httpStatus: ledgerResult.error.httpStatus,
        errorKind: ledgerResult.error.kind,
      });
      return 'not_found_or_failed';
    }

    const ledgerUpdatedAt = ledgerResult.instance.updated_at;
    if (!ledgerUpdatedAt) {
      return 'missing_updated_at';
    }

    if (input.previous?.deviceStatusLedgerUpdatedAt && input.previous.deviceStatusLedgerUpdatedAt >= ledgerUpdatedAt) {
      logLedgerRefresh({ deviceId: input.deviceId, productId, ledgerUpdatedAt, result: 'unchanged' });
      return 'stale';
    }

    const updateResult = await updateDeviceStatusLedgerSnapshot(input.tableName, input.projectId, input.deviceId, {
      updatedAt: ledgerUpdatedAt,
      fetchedAt: (input.fetchedAt || new Date()).toISOString(),
      sizeBytes: ledgerResult.instance.size_bytes,
      data: ledgerResult.data,
    });

    logLedgerRefresh({
      deviceId: input.deviceId,
      productId,
      ledgerUpdatedAt,
      result: updateResult === 'updated' ? 'updated' : 'unchanged',
    });
    return updateResult;
  } catch (err) {
    logLedgerRefresh({ deviceId: input.deviceId, result: 'failed', errorKind: 'exception' });
    return 'not_found_or_failed';
  }
}

type LedgerRefreshLogResult = 'updated' | 'unchanged' | 'failed';

interface LedgerRefreshLogInput {
  deviceId: string;
  productId?: string;
  ledgerUpdatedAt?: string;
  result: LedgerRefreshLogResult;
  httpStatus?: number;
  errorKind?: string;
}

function logLedgerRefresh(input: LedgerRefreshLogInput): void {
  console.info(
    'Ledger refresh',
    JSON.stringify({
      deviceId: input.deviceId,
      ...(input.productId && { productId: input.productId }),
      ledgerName: ParticleLedgerNames.deviceStatus,
      ...(input.ledgerUpdatedAt && { ledgerUpdatedAt: input.ledgerUpdatedAt }),
      result: input.result,
      ...(input.httpStatus !== undefined && { httpStatus: input.httpStatus }),
      ...(input.httpStatus === undefined && input.errorKind && { errorKind: input.errorKind }),
    })
  );
}

function isLedgerRefreshEnabled(): boolean {
  return process.env.PARTICLE_LEDGER_REFRESH_ENABLED === 'true';
}

function isDeviceAllowListed(deviceId: string): boolean {
  return parseAllowList(process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS).has(deviceId);
}

function isEventNameEligible(eventName: string): boolean {
  return parseAllowList(process.env.PARTICLE_LEDGER_REFRESH_EVENT_NAMES).has(eventName);
}

function getRefreshMinIntervalMs(): number {
  const seconds = Number.parseInt(process.env.PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS || '60', 10);
  if (!Number.isFinite(seconds) || seconds < 0) return 60_000;
  return seconds * 1000;
}

function parseAllowList(value: string | undefined): Set<string> {
  return new Set((value || '').split(',').map((entry) => entry.trim()).filter(Boolean));
}

async function resolveProductId(
  body: ParticleWebhook,
  deviceId: string,
  resolvedAt?: Date
): Promise<string | null> {
  const productId = normalizeProductId(body.product_id ?? body.productId);
  if (productId) {
    productIdByDeviceId.set(deviceId, productId);
    return productId;
  }

  const cachedProductId = productIdByDeviceId.get(deviceId);
  if (cachedProductId) return cachedProductId;

  const resolution = await resolveParticleDeviceProductId(deviceId, resolvedAt);
  if (!resolution?.productId) return null;

  productIdByDeviceId.set(deviceId, resolution.productId);
  return resolution.productId;
}

function normalizeProductId(value: string | number | undefined): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

export function clearDeviceProductIdCacheForTests(): void {
  productIdByDeviceId.clear();
  lastRefreshAttemptAtByDeviceId.clear();
  inFlightRefreshByDeviceId.clear();
}