'use strict';

const PRESENTATION_KINDS = new Set([
  'SERIAL',
  'COLLECTOR',
  'TELEMETRY',
  'LIFECYCLE',
  'RUNTIME',
  'DATA',
  'WATCHDOG',
  'ERROR',
  'EVENT',
]);

function presentEvent(event = {}, options = {}) {
  const eventType = text(event.eventType);
  const eventName = text(event.eventName);
  const sourceType = text(event.sourceType);
  const severity = normalizeSeverity(event.severity);
  const kind = classifyKind(event, { eventType, eventName, sourceType, severity });
  const summary = summarizeEvent(event, kind, { eventType, eventName });

  return presentationRecord({
    time: event.eventTime || event.time,
    deviceId: event.deviceId ?? options.deviceId,
    deviceName: options.deviceName ?? event.deviceName,
    kind,
    summary,
    severity,
    sourcePlane: event.plane || event.sourcePlane,
    eventName: event.eventName,
    eventType: event.eventType,
    sourceType: event.sourceType,
    eventId: event.eventId,
    s3Key: event.s3Key,
    rawEvent: options.includeRawEvent ? event : undefined,
  });
}

function presentObservation(kind, input = {}, options = {}) {
  if (!PRESENTATION_KINDS.has(kind)) {
    throw new Error(`Unknown presentation kind: ${kind}`);
  }

  return presentationRecord({
    time: input.time || input.eventTime,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    kind,
    summary: input.summary || defaultObservationSummary(kind, input.state),
    severity: normalizeSeverity(input.severity),
    sourcePlane: input.sourcePlane || input.plane,
    eventName: input.eventName,
    eventType: input.eventType,
    sourceType: input.sourceType,
    eventId: input.eventId,
    s3Key: input.s3Key,
    rawEvent: options.includeRawEvent ? input.rawEvent : undefined,
  });
}

function isRoutineSerialLifecycleEvent(event = {}) {
  const severity = normalizeSeverity(event.severity);
  if (severity === 'warning' || severity === 'error' || severity === 'critical') return false;

  const identities = [event.eventType, event.eventName, event.sourceEventType]
    .map(value => text(value).toUpperCase())
    .filter(Boolean);
  return identities.some(value =>
    value === 'SERIAL_CONNECTING' ||
    value === 'SERIAL_CONNECTED' ||
    value === 'SERIAL_DISCONNECTED' ||
    value === 'SERIAL_MISSING' ||
    value === 'SERIAL.LIFECYCLE.CONNECTING' ||
    value === 'SERIAL.LIFECYCLE.CONNECTED' ||
    value === 'SERIAL.LIFECYCLE.DISCONNECTED' ||
    value === 'SERIAL.LIFECYCLE.MISSING'
  );
}

function presentationRecord(input) {
  const record = {
    time: nullable(input.time),
    deviceId: nullable(input.deviceId),
    deviceName: nullable(input.deviceName),
    kind: input.kind,
    summary: text(input.summary) || 'Event',
    severity: input.severity || null,
    sourcePlane: nullable(input.sourcePlane),
    eventName: nullable(input.eventName),
    eventType: nullable(input.eventType),
    sourceType: nullable(input.sourceType),
    eventId: nullable(input.eventId),
    s3Key: nullable(input.s3Key),
  };

  if (input.rawEvent !== undefined) record.rawEvent = input.rawEvent;
  return record;
}

function classifyKind(event, facts) {
  const eventType = facts.eventType;
  const eventName = facts.eventName;
  const sourceType = facts.sourceType;

  // Canonical eventType is authoritative when it is available.
  // Compatibility correction: some forwarders emitted their connected device
  // path as LOG even though the observation was collector-generated.
  if (eventType === 'serial.log' && isSerialDevicePath(serialLine(event))) return 'COLLECTOR';
  if (eventType === 'serial.log') return 'SERIAL';
  if (isCollectorEventType(eventType)) return 'COLLECTOR';
  if (eventName === 'status') return 'LIFECYCLE';
  // DeviceCurrentState currently retains lastEventType but not lastEventName.
  if (!eventName && eventType === 'telemetry.status') return 'LIFECYCLE';
  if (isWatchdogEvent(eventType, eventName)) return 'WATCHDOG';
  if (isTelemetryEvent(event, eventType)) return 'TELEMETRY';
  if (facts.severity === 'error' || facts.severity === 'critical') return 'ERROR';

  // Explicit compatibility fallbacks for rows created before canonical types.
  const sourceEventType = text(event.sourceEventType).toUpperCase();
  if (!eventType && isLegacyCollectorType(sourceEventType)) return 'COLLECTOR';
  if (!eventType && eventName === 'serialLog' && serialLine(event)) return 'SERIAL';
  if (!eventType && sourceType === 'serial-forwarder') return 'COLLECTOR';

  return 'EVENT';
}

function isCollectorEventType(eventType) {
  return eventType === 'serial.lifecycle' ||
    eventType.startsWith('serial.lifecycle.') ||
    eventType === 'serial.event' ||
    eventType.startsWith('collector.');
}

function isLegacyCollectorType(sourceEventType) {
  return sourceEventType === 'SERIAL_CONNECTED' ||
    sourceEventType === 'SERIAL_DISCONNECTED' ||
    sourceEventType === 'SERIAL_MISSING';
}

function isWatchdogEvent(eventType, eventName) {
  return eventType === 'fault.watchdog' ||
    eventType.startsWith('watchdog.') ||
    eventType.startsWith('fault.') ||
    /(?:watchdog|fault)/i.test(eventName);
}

function isTelemetryEvent(event, eventType) {
  if (eventType.startsWith('telemetry.')) return true;
  return [
    event.occupancy,
    event.dailyOccupancy,
    event.battery,
    event.temperature,
    event.connectTime,
    event.resetCount,
    event.alertCount,
  ].some(value => value !== undefined && value !== null);
}

function summarizeEvent(event, kind, facts) {
  if (kind === 'SERIAL') return serialLine(event) || 'Serial log event';
  if (kind === 'COLLECTOR') return collectorSummary(event, facts.eventType);
  if (kind === 'LIFECYCLE') return 'Device status event';
  if (kind === 'WATCHDOG') return evidenceLine(event) || friendlyType(facts.eventType, facts.eventName, 'Watchdog event');
  if (kind === 'TELEMETRY') return telemetrySummary(event, facts.eventType, facts.eventName);
  if (kind === 'ERROR') return evidenceLine(event) || friendlyType(facts.eventType, facts.eventName, 'Error event');
  return friendlyType(facts.eventType, facts.eventName, 'Event');
}

function collectorSummary(event, eventType) {
  const summaries = {
    'serial.lifecycle.connected': 'Serial device connected',
    'serial.lifecycle.disconnected': 'Serial device disconnected',
    'serial.lifecycle.missing': 'Serial device missing',
  };
  let summary = summaries[eventType];
  if (eventType === 'serial.log' && isSerialDevicePath(serialLine(event))) {
    summary = 'Serial device connected';
  }

  if (!summary && eventType.startsWith('collector.')) {
    summary = friendlyType(eventType, '', 'Serial Forwarder event');
  }
  if (!summary && eventType === 'serial.lifecycle') summary = 'Serial device lifecycle event';
  if (!summary) summary = 'Serial Forwarder event';

  const detail = evidenceLine(event);
  return detail && detail !== summary ? `${summary}: ${detail}` : summary;
}

function telemetrySummary(event, eventType, eventName) {
  const metrics = compactMetricSummary(event);
  if (metrics) return metrics;
  if (eventType === 'telemetry.occupancy') return 'Occupancy report';
  if (eventType === 'telemetry.health') return 'Telemetry health report';
  return friendlyType(eventType, eventName, 'Telemetry event');
}

function compactMetricSummary(event) {
  const fields = [
    ['occupancy', event.occupancy],
    ['dailyOccupancy', event.dailyOccupancy],
    ['battery', event.battery],
    ['temperature', event.temperature],
    ['connectTime', event.connectTime],
    ['resetCount', event.resetCount],
    ['alertCount', event.alertCount],
  ].filter(([, value]) => value !== undefined && value !== null);
  return fields.map(([name, value]) => `${name}=${value}`).join(' ');
}

function serialLine(event) {
  return text(event.serialLogLine) || text(event.logLine) || dataText(event.data);
}

function isSerialDevicePath(value) {
  return /^\/dev\/serial\/by-id\/\S+/.test(text(value));
}

function evidenceLine(event) {
  return serialLine(event) || text(event.message) || text(event.details);
}

function dataText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function friendlyType(eventType, eventName, fallback) {
  const value = text(eventType) || text(eventName);
  if (!value) return fallback;
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function defaultObservationSummary(kind, state) {
  if (kind === 'RUNTIME') return `device-status snapshot ${state || 'updated'}`;
  if (kind === 'DATA') return `device-data snapshot ${state || 'updated'}`;
  return `${kind.charAt(0)}${kind.slice(1).toLowerCase()} observation`;
}

function normalizeSeverity(value) {
  const severity = text(value).toUpperCase();
  if (severity === 'TRACE' || severity === 'DEBUG') return 'debug';
  if (severity === 'INFO') return 'info';
  if (severity === 'WARN' || severity === 'WARNING') return 'warning';
  if (severity === 'ERROR') return 'error';
  if (severity === 'CRITICAL' || severity === 'FATAL') return 'critical';
  return null;
}

function nullable(value) {
  return value === undefined || value === null || value === '' ? null : value;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  PRESENTATION_KINDS,
  compactMetricSummary,
  isRoutineSerialLifecycleEvent,
  normalizeSeverity,
  presentEvent,
  presentObservation,
  serialLine,
};
