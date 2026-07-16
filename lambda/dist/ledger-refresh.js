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
        logLedgerRefreshSkipped({ reason: 'disabled' });
        return 'disabled';
    }
    const eventName = input.body.event || 'unknown';
    if (!isEventNameEligible(eventName)) {
        logLedgerRefreshSkipped({ reason: 'event_not_allowlisted', eventName });
        return 'event_not_eligible';
    }
    if (!isDeviceAllowListed(input.deviceId) && !(await isProductAllowListed(input.body, input.deviceId, input.fetchedAt))) {
        logLedgerRefreshSkipped({ reason: 'device_not_allowlisted', deviceId: input.deviceId });
        return 'not_allow_listed';
    }
    const inFlightRefresh = inFlightRefreshByDeviceId.get(input.deviceId);
    if (inFlightRefresh) {
        logLedgerRefreshSkipped({ reason: 'inflight', deviceId: input.deviceId });
        return inFlightRefresh;
    }
    const nowMs = (input.fetchedAt || new Date()).getTime();
    const lastRefreshAttemptAt = lastRefreshAttemptAtByDeviceId.get(input.deviceId);
    const minIntervalMs = getRefreshMinIntervalMs();
    if (lastRefreshAttemptAt !== undefined && nowMs - lastRefreshAttemptAt < minIntervalMs) {
        logLedgerRefreshSkipped({
            reason: 'cooldown',
            deviceId: input.deviceId,
            remainingSeconds: Math.ceil((minIntervalMs - (nowMs - lastRefreshAttemptAt)) / 1000),
        });
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
    const startedAtMs = Date.now();
    const elapsedMs = () => Math.max(0, Date.now() - startedAtMs);
    try {
        const productId = await resolveProductId(input.body, input.deviceId, input.fetchedAt);
        if (!productId) {
            return 'missing_product_id';
        }
        const ledgerClient = input.ledgerClient || new particle_ledger_1.ParticleLedgerClient();
        const [ledgerResult, productDefaultsResult, deviceSettingsResult] = await Promise.all([
            ledgerClient.getDeviceStatus(productId, input.deviceId),
            ledgerClient.getProductDefaults(productId),
            ledgerClient.getDeviceSettings(productId, input.deviceId),
        ]);
        const fetchedAt = (input.fetchedAt || new Date()).toISOString();
        await projectConfigurationLedgers(input, productDefaultsResult, deviceSettingsResult, fetchedAt);
        if (!ledgerResult.ok) {
            logLedgerRefresh({
                deviceId: input.deviceId,
                productId,
                result: 'failed',
                elapsedMs: elapsedMs(),
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
            logLedgerRefresh({ deviceId: input.deviceId, productId, ledgerUpdatedAt, result: 'unchanged', elapsedMs: elapsedMs() });
            return 'stale';
        }
        const updateResult = await (0, current_state_1.updateDeviceStatusLedgerSnapshot)(input.tableName, input.projectId, input.deviceId, {
            updatedAt: ledgerUpdatedAt,
            fetchedAt,
            sizeBytes: ledgerResult.instance.size_bytes,
            data: ledgerResult.data,
        });
        logLedgerRefresh({
            deviceId: input.deviceId,
            productId,
            ledgerUpdatedAt,
            result: updateResult === 'updated' ? 'updated' : 'unchanged',
            elapsedMs: elapsedMs(),
        });
        return updateResult;
    }
    catch (err) {
        logLedgerRefresh({ deviceId: input.deviceId, result: 'failed', elapsedMs: elapsedMs(), errorKind: 'exception' });
        return 'not_found_or_failed';
    }
}
async function projectConfigurationLedgers(input, productDefaultsResult, deviceSettingsResult, fetchedAt) {
    if (productDefaultsResult.ok && productDefaultsResult.instance.updated_at) {
        await (0, current_state_1.updateProductDefaultsLedgerSnapshot)(input.tableName, input.projectId, input.deviceId, {
            updatedAt: productDefaultsResult.instance.updated_at,
            fetchedAt,
            sizeBytes: productDefaultsResult.instance.size_bytes,
            data: productDefaultsResult.data,
        });
    }
    if (deviceSettingsResult.ok && deviceSettingsResult.instance.updated_at) {
        await (0, current_state_1.updateDeviceSettingsLedgerSnapshot)(input.tableName, input.projectId, input.deviceId, {
            updatedAt: deviceSettingsResult.instance.updated_at,
            fetchedAt,
            sizeBytes: deviceSettingsResult.instance.size_bytes,
            data: deviceSettingsResult.data,
        });
    }
    else if (!deviceSettingsResult.ok && deviceSettingsResult.error.kind === 'missing_ledger') {
        await (0, current_state_1.projectMissingDeviceSettingsLedger)(input.tableName, input.projectId, input.deviceId, fetchedAt);
    }
}
function logLedgerRefresh(input) {
    console.info('Ledger refresh', JSON.stringify({
        deviceId: input.deviceId,
        ...(input.productId && { productId: input.productId }),
        ledgerName: particle_ledger_1.ParticleLedgerNames.deviceStatus,
        ...(input.ledgerUpdatedAt && { ledgerUpdatedAt: input.ledgerUpdatedAt }),
        result: input.result,
        elapsedMs: input.elapsedMs,
        ...(input.httpStatus !== undefined && { httpStatus: input.httpStatus }),
        ...(input.httpStatus === undefined && input.errorKind && { errorKind: input.errorKind }),
    }));
}
function logLedgerRefreshSkipped(input) {
    console.info('Ledger refresh skipped', JSON.stringify({
        reason: input.reason,
        ...(input.deviceId && { deviceId: input.deviceId }),
        ...(input.eventName && { eventName: input.eventName }),
        ...(input.remainingSeconds !== undefined && { remainingSeconds: input.remainingSeconds }),
    }));
}
function isLedgerRefreshEnabled() {
    return process.env.PARTICLE_LEDGER_REFRESH_ENABLED === 'true';
}
function isDeviceAllowListed(deviceId) {
    return parseAllowList(process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS).has(deviceId);
}
async function isProductAllowListed(body, deviceId, resolvedAt) {
    const productIds = parseAllowList(process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS);
    if (productIds.size === 0)
        return false;
    const productId = await resolveProductId(body, deviceId, resolvedAt);
    return productId !== null && productIds.has(productId);
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