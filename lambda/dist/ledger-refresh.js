"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshDeviceStatusLedger = refreshDeviceStatusLedger;
exports.clearDeviceProductIdCacheForTests = clearDeviceProductIdCacheForTests;
const particle_api_1 = require("./integrations/particle-api");
const particle_ledger_1 = require("./integrations/particle-ledger");
const current_state_1 = require("./storage/current-state");
const productIdByDeviceId = new Map();
const lastRefreshAttemptAtByDeviceId = new Map();
const inFlightRefreshByDeviceId = new Map();
async function refreshDeviceStatusLedger(input) {
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
    }
    finally {
        if (inFlightRefreshByDeviceId.get(input.deviceId) === refreshPromise) {
            inFlightRefreshByDeviceId.delete(input.deviceId);
        }
    }
}
async function executeDeviceStatusLedgerRefresh(input) {
    try {
        const productId = await resolveProductId(input.body, input.deviceId, input.fetchedAt);
        if (!productId) {
            return 'missing_product_id';
        }
        const ledgerClient = input.ledgerClient || new particle_ledger_1.ParticleLedgerClient();
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
        const updateResult = await (0, current_state_1.updateDeviceStatusLedgerSnapshot)(input.tableName, input.projectId, input.deviceId, {
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
    }
    catch (err) {
        logLedgerRefresh({ deviceId: input.deviceId, result: 'failed', errorKind: 'exception' });
        return 'not_found_or_failed';
    }
}
function logLedgerRefresh(input) {
    console.info('Ledger refresh', JSON.stringify({
        deviceId: input.deviceId,
        ...(input.productId && { productId: input.productId }),
        ledgerName: particle_ledger_1.ParticleLedgerNames.deviceStatus,
        ...(input.ledgerUpdatedAt && { ledgerUpdatedAt: input.ledgerUpdatedAt }),
        result: input.result,
        ...(input.httpStatus !== undefined && { httpStatus: input.httpStatus }),
        ...(input.httpStatus === undefined && input.errorKind && { errorKind: input.errorKind }),
    }));
}
function isLedgerRefreshEnabled() {
    return process.env.PARTICLE_LEDGER_REFRESH_ENABLED === 'true';
}
function isDeviceAllowListed(deviceId) {
    return parseAllowList(process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS).has(deviceId);
}
function isEventNameEligible(eventName) {
    return parseAllowList(process.env.PARTICLE_LEDGER_REFRESH_EVENT_NAMES).has(eventName);
}
function getRefreshMinIntervalMs() {
    const seconds = Number.parseInt(process.env.PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS || '60', 10);
    if (!Number.isFinite(seconds) || seconds < 0)
        return 60_000;
    return seconds * 1000;
}
function parseAllowList(value) {
    return new Set((value || '').split(',').map((entry) => entry.trim()).filter(Boolean));
}
async function resolveProductId(body, deviceId, resolvedAt) {
    const productId = normalizeProductId(body.product_id ?? body.productId);
    if (productId) {
        productIdByDeviceId.set(deviceId, productId);
        return productId;
    }
    const cachedProductId = productIdByDeviceId.get(deviceId);
    if (cachedProductId)
        return cachedProductId;
    const resolution = await (0, particle_api_1.resolveParticleDeviceProductId)(deviceId, resolvedAt);
    if (!resolution?.productId)
        return null;
    productIdByDeviceId.set(deviceId, resolution.productId);
    return resolution.productId;
}
function normalizeProductId(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    if (typeof value === 'string' && value.trim().length > 0)
        return value.trim();
    return null;
}
function clearDeviceProductIdCacheForTests() {
    productIdByDeviceId.clear();
    lastRefreshAttemptAtByDeviceId.clear();
    inFlightRefreshByDeviceId.clear();
}
//# sourceMappingURL=ledger-refresh.js.map