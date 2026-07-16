"use strict";
/**
 * DynamoDB current-state index for Phase 3A fleet intelligence.
 *
 * This table is intentionally separate from the event history table so fleet
 * endpoints can query one compact item per device by projectId without scanning
 * historical telemetry.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ddb = void 0;
exports.updateDeviceCurrentState = updateDeviceCurrentState;
exports.getDeviceCurrentState = getDeviceCurrentState;
exports.updateDeviceStatusLedgerSnapshot = updateDeviceStatusLedgerSnapshot;
exports.updateProductDefaultsLedgerSnapshot = updateProductDefaultsLedgerSnapshot;
exports.updateDeviceSettingsLedgerSnapshot = updateDeviceSettingsLedgerSnapshot;
exports.projectMissingDeviceSettingsLedger = projectMissingDeviceSettingsLedger;
exports.queryDeviceCurrentStates = queryDeviceCurrentStates;
exports.buildCurrentState = buildCurrentState;
exports.determineHealthStatus = determineHealthStatus;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const DEFAULT_PROJECT_ID = 'generalized-core-counter';
const DEFAULT_OFFLINE_THRESHOLD_HOURS = 3;
const client = new client_dynamodb_1.DynamoDBClient({});
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(client);
exports.ddb = ddb;
async function updateDeviceCurrentState(tableName, deviceId, eventTime, eventName, body, parsed, normalized, options = {}) {
    const projectId = normalized?.projectId || body.projectId || DEFAULT_PROJECT_ID;
    const previous = options.previous !== undefined
        ? options.previous
        : await getDeviceCurrentState(tableName, projectId, deviceId);
    const updatedAt = new Date().toISOString();
    const state = buildCurrentState({
        projectId,
        deviceId,
        eventTime,
        eventName,
        body,
        parsed,
        normalized,
        previous,
        deviceNameResolution: options.deviceNameResolution,
        updatedAt,
    });
    await ddb.send(new lib_dynamodb_1.UpdateCommand({
        TableName: tableName,
        Key: { projectId, deviceId },
        ...buildUpdateExpression(state),
    }));
}
async function getDeviceCurrentState(tableName, projectId, deviceId) {
    const result = await ddb.send(new lib_dynamodb_1.GetCommand({
        TableName: tableName,
        Key: { projectId, deviceId },
    }));
    return result.Item || null;
}
async function updateDeviceStatusLedgerSnapshot(tableName, projectId, deviceId, snapshot) {
    return updateProjectedLedgerSnapshot(tableName, projectId, deviceId, 'deviceStatus', snapshot);
}
async function updateProductDefaultsLedgerSnapshot(tableName, projectId, deviceId, snapshot) {
    return updateProjectedLedgerSnapshot(tableName, projectId, deviceId, 'productDefaults', snapshot);
}
async function updateDeviceSettingsLedgerSnapshot(tableName, projectId, deviceId, snapshot) {
    return updateProjectedLedgerSnapshot(tableName, projectId, deviceId, 'deviceSettings', snapshot);
}
async function updateProjectedLedgerSnapshot(tableName, projectId, deviceId, ledger, snapshot) {
    const prefix = ledger;
    const assignments = [
        '#ledgerUpdatedAt = :incomingUpdatedAt',
        '#ledgerFetchedAt = :fetchedAt',
        '#ledgerData = :ledgerData',
    ];
    const names = {
        '#ledgerUpdatedAt': `${prefix}LedgerUpdatedAt`,
        '#ledgerFetchedAt': `${prefix}LedgerFetchedAt`,
        '#ledgerData': `${prefix}LedgerData`,
    };
    const values = {
        ':incomingUpdatedAt': snapshot.updatedAt,
        ':fetchedAt': snapshot.fetchedAt,
        ':ledgerData': snapshot.data,
    };
    if (snapshot.sizeBytes !== undefined) {
        names['#ledgerSizeBytes'] = `${prefix}LedgerSizeBytes`;
        values[':sizeBytes'] = snapshot.sizeBytes;
        assignments.push('#ledgerSizeBytes = :sizeBytes');
    }
    try {
        await ddb.send(new lib_dynamodb_1.UpdateCommand({
            TableName: tableName,
            Key: { projectId, deviceId },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ConditionExpression: 'attribute_not_exists(#ledgerUpdatedAt) OR #ledgerUpdatedAt < :incomingUpdatedAt',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
        }));
        return 'updated';
    }
    catch (err) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
            return 'stale';
        }
        throw err;
    }
}
async function projectMissingDeviceSettingsLedger(tableName, projectId, deviceId, fetchedAt) {
    try {
        await ddb.send(new lib_dynamodb_1.UpdateCommand({
            TableName: tableName,
            Key: { projectId, deviceId },
            UpdateExpression: 'SET #ledgerFetchedAt = :fetchedAt REMOVE #ledgerUpdatedAt, #ledgerSizeBytes, #ledgerData',
            ConditionExpression: 'attribute_not_exists(#ledgerFetchedAt) OR #ledgerFetchedAt < :fetchedAt',
            ExpressionAttributeNames: {
                '#ledgerUpdatedAt': 'deviceSettingsLedgerUpdatedAt',
                '#ledgerFetchedAt': 'deviceSettingsLedgerFetchedAt',
                '#ledgerSizeBytes': 'deviceSettingsLedgerSizeBytes',
                '#ledgerData': 'deviceSettingsLedgerData',
            },
            ExpressionAttributeValues: { ':fetchedAt': fetchedAt },
        }));
        return 'updated';
    }
    catch (err) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException')
            return 'stale';
        throw err;
    }
}
async function queryDeviceCurrentStates(tableName, projectId, limit = 100) {
    const result = await ddb.send(new lib_dynamodb_1.QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'projectId = :projectId',
        ExpressionAttributeValues: {
            ':projectId': projectId,
        },
        Limit: limit,
    }));
    return (result.Items || []);
}
function buildCurrentState(input) {
    const effective = mergePreviousMetrics(input.previous, input.normalized);
    const resetIncreased = input.previous?.resetCount !== undefined &&
        effective.resetCount !== undefined &&
        effective.resetCount > input.previous.resetCount;
    const healthStatus = determineStateHealthStatus(effective, resetIncreased, input.previous, input.normalized);
    const anomalies = buildAnomalies(effective, resetIncreased);
    const recentSerialErrorCount = input.normalized?.severity === 'ERROR'
        ? (input.previous?.recentSerialErrorCount || 0) + 1
        : input.previous?.recentSerialErrorCount || 0;
    return omitUndefined({
        projectId: input.projectId,
        deviceId: input.deviceId,
        deviceName: input.previous?.deviceName ||
            input.deviceNameResolution?.deviceName ||
            input.normalized?.deviceName ||
            input.body.deviceName,
        deviceNameResolvedAt: input.previous?.deviceNameResolvedAt || input.deviceNameResolution?.deviceNameResolvedAt,
        deviceNameSource: input.previous?.deviceNameSource || input.deviceNameResolution?.deviceNameSource,
        lastEventTime: input.eventTime,
        lastApplicationReportAt: input.normalized?.plane === 'telemetry'
            ? input.eventTime
            : input.previous?.lastApplicationReportAt,
        lastIngestTime: input.parsed.receivedAt,
        lastEventType: input.normalized?.eventType || input.body.eventType || input.eventName,
        lastPlane: input.normalized?.plane || input.previous?.lastPlane,
        lastSourceType: input.normalized?.sourceType || input.body.sourceType || input.previous?.lastSourceType,
        fwVersion: input.normalized?.fwVersion || input.body.fw_version || input.previous?.fwVersion,
        battery: effective.battery,
        connectTime: effective.connectTime,
        resetCount: effective.resetCount,
        alertCount: effective.alertCount,
        occupancy: effective.occupancy,
        dailyOccupancy: effective.dailyOccupancy,
        temperature: effective.temperature,
        severity: effective.severity,
        networkState: input.normalized?.networkState || input.previous?.networkState,
        serialCategory: hasNormalizedField(input.normalized, 'serialCategory')
            ? input.normalized?.serialCategory
            : input.previous?.serialCategory,
        lastSerialLogLine: input.normalized?.eventType === 'serial.log'
            ? input.normalized.serialLogLine
            : input.previous?.lastSerialLogLine,
        recentSerialErrorCount,
        reconnectDetected: effective.reconnectDetected,
        watchdogDetected: effective.watchdogDetected,
        resetDetected: effective.resetDetected,
        healthStatus,
        anomalyCount: anomalies.length,
        anomalies,
        offlineCandidate: isOfflineCandidate(input.eventTime, DEFAULT_OFFLINE_THRESHOLD_HOURS, input.updatedAt),
        updatedAt: input.updatedAt,
    });
}
function mergePreviousMetrics(previous, normalized) {
    return {
        battery: normalized?.battery ?? previous?.battery,
        connectTime: normalized?.connectTime ?? previous?.connectTime,
        resetCount: normalized?.resetCount ?? previous?.resetCount,
        alertCount: normalized?.alertCount ?? previous?.alertCount,
        occupancy: normalized?.occupancy ?? previous?.occupancy,
        dailyOccupancy: normalized?.dailyOccupancy ?? previous?.dailyOccupancy,
        temperature: normalized?.temperature ?? previous?.temperature,
        severity: normalized?.severity,
        reconnectDetected: normalized?.reconnectDetected ?? previous?.reconnectDetected,
        watchdogDetected: normalized?.watchdogDetected ?? previous?.watchdogDetected,
        resetDetected: normalized?.resetDetected ?? previous?.resetDetected,
    };
}
function hasNormalizedField(normalized, field) {
    return normalized ? Object.prototype.hasOwnProperty.call(normalized, field) : false;
}
function determineStateHealthStatus(state, resetIncreased, previous, normalized) {
    if (normalized?.plane === 'serial') {
        if (state.severity === 'ERROR' || state.watchdogDetected)
            return 'critical';
        if (state.severity === 'WARN' || state.reconnectDetected || state.resetDetected)
            return 'warning';
        return previous?.healthStatus || 'unknown';
    }
    return determineHealthStatus(state, resetIncreased);
}
function determineHealthStatus(state, resetIncreased) {
    if ((state.battery !== undefined && state.battery < 20) ||
        (state.alertCount !== undefined && state.alertCount > 0) ||
        (state.connectTime !== undefined && state.connectTime > 300) ||
        state.severity === 'ERROR') {
        return 'critical';
    }
    if ((state.battery !== undefined && state.battery < 30) ||
        (state.connectTime !== undefined && state.connectTime > 180) ||
        state.severity === 'WARN' ||
        resetIncreased) {
        return 'warning';
    }
    const hasHealthSignal = state.battery !== undefined ||
        state.connectTime !== undefined ||
        state.resetCount !== undefined ||
        state.alertCount !== undefined ||
        state.severity !== undefined;
    return hasHealthSignal ? 'healthy' : 'unknown';
}
function buildAnomalies(state, resetIncreased) {
    const anomalies = [];
    if (state.battery !== undefined && state.battery < 20) {
        anomalies.push({ severity: 'high', type: 'critical_battery', message: 'Battery below 20%' });
    }
    else if (state.battery !== undefined && state.battery < 30) {
        anomalies.push({ severity: 'medium', type: 'low_battery', message: 'Battery below 30%' });
    }
    if (state.connectTime !== undefined && state.connectTime > 300) {
        anomalies.push({ severity: 'high', type: 'very_high_connect_time', message: 'Connect time exceeded 300 seconds' });
    }
    else if (state.connectTime !== undefined && state.connectTime > 180) {
        anomalies.push({ severity: 'medium', type: 'high_connect_time', message: 'Connect time exceeded 180 seconds' });
    }
    if (state.alertCount !== undefined && state.alertCount > 0) {
        anomalies.push({ severity: 'high', type: 'active_alerts', message: 'Active alert count is non-zero' });
    }
    if (state.severity === 'ERROR') {
        anomalies.push({ severity: 'high', type: 'serial_error', message: 'Latest serial event is ERROR severity' });
    }
    else if (state.severity === 'WARN') {
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
    if (resetIncreased) {
        anomalies.push({ severity: 'medium', type: 'reset_count_increase', message: 'Reset count increased since previous state' });
    }
    return anomalies.slice(0, 10);
}
function isOfflineCandidate(eventTime, thresholdHours, now) {
    return new Date(eventTime).getTime() < new Date(now).getTime() - thresholdHours * 60 * 60 * 1000;
}
function buildUpdateExpression(state) {
    const names = {};
    const values = {};
    const assignments = [];
    for (const [field, value] of Object.entries(state)) {
        if (field === 'projectId' || field === 'deviceId') {
            continue;
        }
        names[`#${field}`] = field;
        values[`:${field}`] = value;
        assignments.push(`#${field} = :${field}`);
    }
    return {
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
    };
}
function omitUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}
//# sourceMappingURL=current-state.js.map