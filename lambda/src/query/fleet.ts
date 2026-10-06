/**
 * Fleet query endpoints backed by DeviceCurrentState.
 *
 * These endpoints query the compact current-state table by projectId. They do
 * not scan the historical event table and do not read raw S3 payloads.
 */

import {
  DeviceCurrentState,
  DeviceHealthStatus,
  FleetAnomaliesResponse,
  FleetOfflineResponse,
  FleetSummaryResponse,
} from '../types';
import { queryDeviceCurrentStates } from '../storage/current-state';

const DEFAULT_PROJECT_ID = 'generalized-core-counter';
const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_OFFLINE_THRESHOLD_HOURS = 3;

export async function handleFleetSummaryQuery(
  queryParameters: Record<string, string | undefined> | undefined
): Promise<FleetSummaryResponse> {
  const params = parseFleetParams(queryParameters);
  const devices = await loadCurrentStates(params.projectId, params.limit);
  const filtered = filterByStatus(devices, params.status);

  return {
    projectId: params.projectId,
    deviceCount: filtered.length,
    healthy: countStatus(filtered, 'healthy'),
    warning: countStatus(filtered, 'warning'),
    watchdogReset: countStatus(filtered, 'watchdog_reset'),
    critical: countStatus(filtered, 'critical'),
    unknown: countStatus(filtered, 'unknown'),
    lowBatteryCount: filtered.filter(device => device.battery !== undefined && device.battery < 30).length,
    highConnectTimeCount: filtered.filter(device => device.connectTime !== undefined && device.connectTime > 180).length,
    alertingDeviceCount: filtered.filter(device => device.alertCount !== undefined && device.alertCount > 0).length,
    recentSerialErrorCount: filtered.filter(device => isRecentSerialError(device, params.hours)).length,
    devices: filtered.map(device => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName || null,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export async function handleFleetAnomaliesQuery(
  queryParameters: Record<string, string | undefined> | undefined
): Promise<FleetAnomaliesResponse> {
  const params = parseFleetParams(queryParameters);
  const devices = filterByStatus(await loadCurrentStates(params.projectId, params.limit), params.status)
    .filter(device => device.anomalyCount > 0 || device.healthStatus === 'warning' || device.healthStatus === 'watchdog_reset' || device.healthStatus === 'critical')
    .filter(device => isWithinHours(device.lastEventTime, params.hours))
    .sort(compareFleetRisk)
    .slice(0, params.limit);

  return {
    projectId: params.projectId,
    count: devices.length,
    devices: devices.map(device => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName || null,
      healthStatus: device.healthStatus,
      lastEventTime: device.lastEventTime,
      ...(device.battery !== undefined && { battery: device.battery }),
      ...(device.connectTime !== undefined && { connectTime: device.connectTime }),
      anomalies: device.anomalies || [],
    })),
  };
}

export async function handleFleetOfflineQuery(
  queryParameters: Record<string, string | undefined> | undefined
): Promise<FleetOfflineResponse> {
  const params = parseFleetParams(queryParameters);
  const thresholdHours = parsePositiveNumber(queryParameters?.thresholdHours, DEFAULT_OFFLINE_THRESHOLD_HOURS, 720);
  const devices = await loadCurrentStates(params.projectId, params.limit);
  const offlineDevices = devices
    .filter(device => isOffline(device.lastEventTime, thresholdHours))
    .sort((a, b) => new Date(a.lastEventTime).getTime() - new Date(b.lastEventTime).getTime())
    .slice(0, params.limit);

  return {
    projectId: params.projectId,
    thresholdHours,
    count: offlineDevices.length,
    devices: offlineDevices.map(device => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName || null,
      lastEventTime: device.lastEventTime,
      lastPlane: device.lastPlane,
      lastEventType: device.lastEventType,
      offlineCandidate: true,
    })),
  };
}

interface FleetParams {
  projectId: string;
  hours: number;
  limit: number;
  status?: DeviceHealthStatus;
}

async function loadCurrentStates(projectId: string, limit: number): Promise<DeviceCurrentState[]> {
  const tableName = process.env.DEVICE_CURRENT_STATE_TABLE_NAME;
  if (!tableName) {
    throw new Error('DEVICE_CURRENT_STATE_TABLE_NAME environment variable not set');
  }

  return queryDeviceCurrentStates(tableName, projectId, limit);
}

function parseFleetParams(queryParameters: Record<string, string | undefined> | undefined): FleetParams {
  const params = queryParameters || {};
  return {
    projectId: params.projectId || DEFAULT_PROJECT_ID,
    hours: parsePositiveNumber(params.hours, DEFAULT_HOURS, 720),
    limit: parsePositiveNumber(params.limit, DEFAULT_LIMIT, MAX_LIMIT),
    status: parseStatus(params.status),
  };
}

function parsePositiveNumber(value: string | undefined, defaultValue: number, maxValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new Error(`Invalid numeric query parameter: ${value}`);
  }
  return parsed;
}

function parseStatus(status: string | undefined): DeviceHealthStatus | undefined {
  if (!status) return undefined;
  const normalized = status.toLowerCase();
  if (!['healthy', 'warning', 'watchdog_reset', 'critical', 'unknown'].includes(normalized)) {
    throw new Error(`Invalid status: ${status}. Must be one of healthy, warning, watchdog_reset, critical, unknown`);
  }
  return normalized as DeviceHealthStatus;
}

function filterByStatus(devices: DeviceCurrentState[], status: DeviceHealthStatus | undefined): DeviceCurrentState[] {
  return status ? devices.filter(device => device.healthStatus === status) : devices;
}

function countStatus(devices: DeviceCurrentState[], status: DeviceHealthStatus): number {
  return devices.filter(device => device.healthStatus === status).length;
}

function isRecentSerialError(device: DeviceCurrentState, hours: number): boolean {
  return device.lastPlane === 'serial' && device.severity === 'ERROR' && isWithinHours(device.lastEventTime, hours);
}

function isWithinHours(timestamp: string, hours: number): boolean {
  return new Date(timestamp).getTime() >= Date.now() - hours * 60 * 60 * 1000;
}

function isOffline(timestamp: string, thresholdHours: number): boolean {
  return new Date(timestamp).getTime() < Date.now() - thresholdHours * 60 * 60 * 1000;
}

function compareFleetRisk(a: DeviceCurrentState, b: DeviceCurrentState): number {
  const statusOrder: Record<DeviceHealthStatus, number> = {
    critical: 5,
    watchdog_reset: 4,
    warning: 3,
    unknown: 2,
    healthy: 1,
  };

  const statusDiff = statusOrder[b.healthStatus] - statusOrder[a.healthStatus];
  if (statusDiff !== 0) return statusDiff;
  return new Date(b.lastEventTime).getTime() - new Date(a.lastEventTime).getTime();
}