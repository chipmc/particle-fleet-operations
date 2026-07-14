/**
 * Timeline Query Endpoint
 * 
 * GET /device/{deviceId}/timeline
 * 
 * Returns chronological event list with normalized fields from Phase 2A.
 */

import { TimelineResponse, TimelineEvent, DynamoIndexRecord } from '../types';
import { queryDeviceEvents, deviceHasEvents } from '../storage/dynamo-read';
import { parseQueryParams, extractDeviceId } from '../utils/query-params';

/**
 * Handle timeline query request
 * 
 * Query parameters:
 * - hours: Query last N hours (default: 24, max: 168)
 * - start: Explicit start time (ISO8601)
 * - end: Explicit end time (ISO8601)
 * - limit: Max events to return (default: 100, max: 1000)
 * 
 * @param pathParameters - Path parameters from API Gateway
 * @param queryParameters - Query string parameters
 * @returns Timeline response
 */
export async function handleTimelineQuery(
  pathParameters: Record<string, string | undefined> | undefined,
  queryParameters: Record<string, string | undefined> | undefined
): Promise<TimelineResponse> {
  const tableName = process.env.LOG_EVENTS_TABLE_NAME;
  if (!tableName) {
    throw new Error('LOG_EVENTS_TABLE_NAME environment variable not set');
  }

  // Extract device ID from path
  const deviceId = extractDeviceId(pathParameters);

  // Parse and validate query parameters
  const params = parseQueryParams(queryParameters || {}, {
    defaultHours: 24,
    maxHours: 168,
    defaultLimit: 100,
    maxLimit: 1000,
  });

  // Check if device has any events
  const hasEvents = await deviceHasEvents(tableName, deviceId);
  if (!hasEvents) {
    throw new Error(`No data found for device: ${deviceId}`);
  }

  // Query events from DynamoDB
  const events = await queryDeviceEvents(
    tableName,
    deviceId,
    params.timeRange.start,
    params.timeRange.end,
    params.limit,
    true // newest first
  );

  // Format events for response
  const formattedEvents = formatTimelineEvents(events);

  return {
    deviceId,
    start: params.timeRange.start,
    end: params.timeRange.end,
    count: formattedEvents.length,
    events: formattedEvents,
  };
}

/**
 * Format DynamoDB records into timeline events
 * 
 * Includes normalized Phase 2A fields when available.
 */
function formatTimelineEvents(records: DynamoIndexRecord[]): TimelineEvent[] {
  return records.map(record => {
    const event: TimelineEvent = {
      eventTime: record.eventTime,
      eventName: record.eventName,
      s3Key: record.s3Key,
    };

    // Add normalized Phase 2A fields if present
    if (record.eventId) event.eventId = record.eventId;
    if (record.eventType) event.eventType = record.eventType;
    if (record.plane) event.plane = record.plane;
    if (record.severity) event.severity = record.severity;
    if (record.fwVersion) event.fwVersion = record.fwVersion;

    // Add telemetry metrics if present
    if (record.battery !== undefined) event.battery = record.battery;
    if (record.connectTime !== undefined) event.connectTime = record.connectTime;
    if (record.resetCount !== undefined) event.resetCount = record.resetCount;
    if (record.alertCount !== undefined) event.alertCount = record.alertCount;
    if (record.temperature !== undefined) event.temperature = record.temperature;
    if (record.occupancy !== undefined) event.occupancy = record.occupancy;
    if (record.dailyOccupancy !== undefined) event.dailyOccupancy = record.dailyOccupancy;
    if (record.serialLogLine) event.serialLogLine = record.serialLogLine;
    if (record.logLine) event.logLine = record.logLine;

    return event;
  });
}
