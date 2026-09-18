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
export declare function detectAnomalies(events: DynamoIndexRecord[]): Anomaly[];
/**
 * Filter anomalies by severity
 *
 * @param anomalies - All detected anomalies
 * @param severity - Minimum severity to include
 * @returns Filtered anomalies
 */
export declare function filterBySeverity(anomalies: Anomaly[], severity: AnomalySeverity): Anomaly[];
/**
 * Sort anomalies by severity (high first) then by time (newest first)
 */
export declare function sortAnomalies(anomalies: Anomaly[]): Anomaly[];
//# sourceMappingURL=anomaly-detection.d.ts.map