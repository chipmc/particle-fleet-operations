/**
 * Anomaly detection rules for device health monitoring
 * 
 * Shared between health and anomalies query endpoints.
 * Detection rules based on normalized Phase 2A fields.
 */

import { DynamoIndexRecord } from '../types';

export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface Anomaly {
  severity: AnomalySeverity;
  type: string;
  eventTime: string;
  message: string;
  value?: number | string;
}

/**
 * Detect anomalies in device events
 * 
 * Applies heuristic rules to identify device health issues:
 * - Low battery conditions
 * - High cellular connection times
 * - Active alerts
 * - Firmware version changes
 * - Rapid battery drain
 * 
 * @param events - Device events from DynamoDB (sorted chronologically)
 * @returns Array of detected anomalies
 */
export function detectAnomalies(events: DynamoIndexRecord[]): Anomaly[] {
  const anomalies: Anomaly[] = [];

  if (events.length === 0) {
    return anomalies;
  }

  // Track metrics across events
  const batteryReadings: Array<{ time: string; value: number }> = [];
  const firmwareVersions: Array<{ time: string; value: string }> = [];

  // Scan events for anomalies
  for (const event of events) {
    // Battery anomalies
    if (event.battery !== undefined && event.battery !== null) {
      batteryReadings.push({ time: event.eventTime, value: event.battery });

      if (event.battery < 20) {
        anomalies.push({
          severity: 'high',
          type: 'critical_battery',
          eventTime: event.eventTime,
          message: `Critical battery level: ${event.battery.toFixed(1)}%`,
          value: event.battery,
        });
      } else if (event.battery < 30) {
        anomalies.push({
          severity: 'medium',
          type: 'low_battery',
          eventTime: event.eventTime,
          message: `Low battery level: ${event.battery.toFixed(1)}%`,
          value: event.battery,
        });
      }
    }

    // Connection time anomalies
    if (event.connectTime !== undefined && event.connectTime !== null) {
      if (event.connectTime > 300) {
        anomalies.push({
          severity: 'high',
          type: 'very_high_connect_time',
          eventTime: event.eventTime,
          message: `Very high connection time: ${event.connectTime}s (threshold: 300s)`,
          value: event.connectTime,
        });
      } else if (event.connectTime > 180) {
        anomalies.push({
          severity: 'medium',
          type: 'high_connect_time',
          eventTime: event.eventTime,
          message: `High connection time: ${event.connectTime}s (threshold: 180s)`,
          value: event.connectTime,
        });
      }
    }

    // Alert anomalies
    if (event.alertCount !== undefined && event.alertCount !== null && event.alertCount > 0) {
      anomalies.push({
        severity: 'high',
        type: 'active_alerts',
        eventTime: event.eventTime,
        message: `Active alerts detected: ${event.alertCount}`,
        value: event.alertCount,
      });
    }

    // Firmware version tracking
    if (event.fwVersion && typeof event.fwVersion === 'string') {
      firmwareVersions.push({ time: event.eventTime, value: event.fwVersion });
    }
  }

  // Detect firmware version changes
  if (firmwareVersions.length > 1) {
    for (let i = 1; i < firmwareVersions.length; i++) {
      const prev = firmwareVersions[i - 1];
      const curr = firmwareVersions[i];

      if (curr.value !== prev.value) {
        anomalies.push({
          severity: 'low',
          type: 'firmware_change',
          eventTime: curr.time,
          message: `Firmware changed from ${prev.value} to ${curr.value}`,
          value: `${prev.value} → ${curr.value}`,
        });
      }
    }
  }

  // Detect rapid battery drain
  if (batteryReadings.length > 1) {
    const first = batteryReadings[0];
    const last = batteryReadings[batteryReadings.length - 1];
    const drop = first.value - last.value;
    const dropPercent = (drop / first.value) * 100;

    if (drop > 30 && dropPercent > 30) {
      anomalies.push({
        severity: 'medium',
        type: 'rapid_battery_drain',
        eventTime: last.time,
        message: `Rapid battery drain: ${drop.toFixed(1)}% drop (${dropPercent.toFixed(0)}% of initial)`,
        value: drop,
      });
    }
  }

  return anomalies;
}

/**
 * Filter anomalies by severity
 * 
 * @param anomalies - All detected anomalies
 * @param severity - Minimum severity to include
 * @returns Filtered anomalies
 */
export function filterBySeverity(
  anomalies: Anomaly[],
  severity: AnomalySeverity
): Anomaly[] {
  const severityOrder: Record<AnomalySeverity, number> = {
    low: 1,
    medium: 2,
    high: 3,
  };

  const minLevel = severityOrder[severity];

  return anomalies.filter(a => severityOrder[a.severity] >= minLevel);
}

/**
 * Sort anomalies by severity (high first) then by time (newest first)
 */
export function sortAnomalies(anomalies: Anomaly[]): Anomaly[] {
  const severityOrder: Record<AnomalySeverity, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  return [...anomalies].sort((a, b) => {
    // Sort by severity first (high to low)
    const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
    if (severityDiff !== 0) return severityDiff;

    // Then by time (newest first)
    return new Date(b.eventTime).getTime() - new Date(a.eventTime).getTime();
  });
}
