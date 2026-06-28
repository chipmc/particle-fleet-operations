/**
 * Display formatters for timeline output
 * Plain text formatting (no color dependencies)
 */

import { DynamoIndexRecord, S3StorageRecord } from '../types';

/**
 * Format timeline event for console display
 */
export function formatTimelineEvent(event: DynamoIndexRecord, index: number): string {
  const lines: string[] = [];
  
  // Header with index
  lines.push(`\n[${index + 1}] ================================================================`);
  
  // Core fields
  lines.push('Event:      ' + event.eventName);
  lines.push('Time:       ' + event.eventTime);
  lines.push('Received:   ' + event.receivedAt);
  lines.push('Data Type:  ' + event.dataType);
  
  // Optional fields
  if (event.fw_version) {
    lines.push('Firmware:   ' + event.fw_version);
  }
  
  if (event.deviceName) {
    lines.push('Device:     ' + event.deviceName);
  }
  
  if (event.sourceType) {
    lines.push('Source:     ' + event.sourceType);
  }
  
  if (event.collectorId) {
    lines.push('Collector:  ' + event.collectorId);
  }
  
  if (event.eventType) {
    lines.push('Type:       ' + event.eventType);
  }
  
  if (event.logLine) {
    lines.push('Log:        ' + event.logLine.substring(0, 80));
  }
  
  // S3 reference
  lines.push('S3 Key:     ' + event.s3Key);
  
  return lines.join('\n');
}

/**
 * Format timeline summary header
 */
export function formatTimelineHeader(deviceId: string, count: number, startTime?: string, endTime?: string): string {
  const lines: string[] = [];
  lines.push('\n================================================================');
  lines.push('  Device Timeline');
  lines.push('================================================================');
  lines.push('');
  lines.push('Device ID:   ' + deviceId);
  
  if (startTime) {
    lines.push('Start Time:  ' + startTime);
  }
  
  if (endTime) {
    lines.push('End Time:    ' + endTime);
  }
  
  lines.push('Event Count: ' + count.toString());
  
  return lines.join('\n');
}

/**
 * Format raw S3 event data
 */
export function formatRawEvent(record: S3StorageRecord): string {
  const lines: string[] = [];
  
  lines.push('\n================================================================');
  lines.push('Raw Event Data (from S3)');
  lines.push('================================================================');
  
  lines.push('');
  lines.push('Particle Webhook:');
  lines.push(JSON.stringify(record.particle, null, 2));
  
  lines.push('');
  lines.push('Parsed Data:');
  lines.push(JSON.stringify(record.parsed, null, 2));
  
  return lines.join('\n');
}

/**
 * Format error message
 */
export function formatError(message: string, error?: Error): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('ERROR: ' + message);
  if (error) {
    lines.push(error.message);
    if (error.stack) {
      lines.push('');
      lines.push('Stack trace:');
      lines.push(error.stack);
    }
  }
  lines.push('');
  return lines.join('\n');
}
