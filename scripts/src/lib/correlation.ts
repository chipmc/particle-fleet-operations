/**
 * Event correlation module
 * 
 * Groups events into time windows and correlates different event types
 * to identify patterns and causal relationships.
 */

import { DynamoIndexRecord, S3StorageRecord } from '../types';

/**
 * Correlation window containing grouped events
 */
export interface CorrelationWindow {
  startTime: string;
  endTime: string;
  durationMinutes: number;
  events: DynamoIndexRecord[];
  telemetry: TelemetryData[];
  watchdog: WatchdogData[];
  status: StatusData[];
  serialLifecycle: SerialLifecycleData[];
  serialLogs: SerialLogData[];
  inferences: Inference[];
}

/**
 * Extracted telemetry data
 */
export interface TelemetryData {
  timestamp: string;
  eventName: string;
  battery?: number;
  connecttime?: number;
  temperature?: number;
  resets?: number;
  alerts?: number;
  occupancy?: number;
}

/**
 * Extracted watchdog data
 */
export interface WatchdogData {
  timestamp: string;
  eventName: string;
  resetCause?: string;
  details?: string;
}

/**
 * Extracted status data
 */
export interface StatusData {
  timestamp: string;
  eventName: string;
  cloudRecoverStage?: number;
  networkState?: string;
  queueDepth?: number;
  details?: string;
}

/**
 * Serial lifecycle event data
 */
export interface SerialLifecycleData {
  timestamp: string;
  eventName: string;
  eventType: 'SERIAL_CONNECTED' | 'SERIAL_DISCONNECTED' | 'SERIAL_MISSING' | 'MODEM_HEALTH' | 'OTHER';
  details?: string;
}

/**
 * Serial log data
 */
export interface SerialLogData {
  timestamp: string;
  logLine: string;
  category?: 'modem' | 'network' | 'power' | 'error' | 'reconnect' | 'other';
}

/**
 * Inference about correlated events
 */
export interface Inference {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  category: 'connectivity' | 'power' | 'stability' | 'hardware';
  message: string;
  evidence: string[];
}

/**
 * Complete correlation analysis result
 */
export interface CorrelationAnalysis {
  deviceId: string;
  startTime: string;
  endTime: string;
  windowCount: number;
  windowDurationMinutes: number;
  windows: CorrelationWindow[];
  summary: {
    totalInferences: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    topCategories: Record<string, number>;
  };
}

/**
 * Parse payload data (reuse from health module logic)
 */
function parsePayloadData(data: any): any {
  if (!data) return null;
  
  if (typeof data === 'object') return data;
  
  if (typeof data === 'string') {
    try {
      const decoded = data
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'");
      
      return JSON.parse(decoded);
    } catch {
      try {
        return JSON.parse(data);
      } catch {
        try {
          const fixed = '{' + data
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'");
          
          const finalFixed = fixed.endsWith('}') ? fixed : fixed + '}';
          return JSON.parse(finalFixed);
        } catch {
          return null;
        }
      }
    }
  }
  
  return null;
}

/**
 * Extract telemetry data from S3 payload
 */
function extractTelemetry(event: DynamoIndexRecord, payload: S3StorageRecord): TelemetryData | null {
  let data = null;
  if (payload.parsed?.data) {
    data = parsePayloadData(payload.parsed.data);
  }
  if (!data && payload.particle?.data) {
    data = parsePayloadData(payload.particle.data);
  }
  
  const particle = payload.particle || {};
  
  const getNumeric = (field: string): number | undefined => {
    const fromData = data?.[field];
    const fromParticle = particle[field];
    const value = fromData ?? fromParticle;
    if (value === null || value === undefined) return undefined;
    const num = typeof value === 'number' ? value : parseFloat(value);
    return isNaN(num) ? undefined : num;
  };
  
  const telemetry: TelemetryData = {
    timestamp: event.eventTime,
    eventName: event.eventName,
  };
  
  const battery = getNumeric('battery');
  const connecttime = getNumeric('connecttime');
  const temperature = getNumeric('temp') ?? getNumeric('temperature');
  const resets = getNumeric('resets');
  const alerts = getNumeric('alerts');
  const occupancy = getNumeric('occupancy');
  
  if (battery !== undefined) telemetry.battery = battery;
  if (connecttime !== undefined) telemetry.connecttime = connecttime;
  if (temperature !== undefined) telemetry.temperature = temperature;
  if (resets !== undefined) telemetry.resets = resets;
  if (alerts !== undefined) telemetry.alerts = alerts;
  if (occupancy !== undefined) telemetry.occupancy = occupancy;
  
  // Only return if we extracted at least one metric
  if (Object.keys(telemetry).length > 2) {
    return telemetry;
  }
  
  return null;
}

/**
 * Classify event by type
 */
function classifyEvent(event: DynamoIndexRecord): 'telemetry' | 'watchdog' | 'status' | 'serial-lifecycle' | 'serial-log' | 'other' {
  const name = event.eventName.toLowerCase();
  const sourceEventType = event.sourceEventType || event.eventType;
  
  if (name.includes('watchdog')) return 'watchdog';
  if (name.includes('status') || name.includes('state')) return 'status';
  if (
    event.eventType === 'serial.lifecycle' ||
    sourceEventType === 'SERIAL_CONNECTED' ||
    sourceEventType === 'SERIAL_DISCONNECTED' ||
    sourceEventType === 'SERIAL_MISSING'
  ) {
    return 'serial-lifecycle';
  }
  if (event.eventType === 'serial.log' || (event.sourceType === 'serial-forwarder' && event.logLine)) {
    return 'serial-log';
  }
  
  return 'telemetry';
}

/**
 * Extract watchdog data
 */
function extractWatchdog(event: DynamoIndexRecord, payload: S3StorageRecord): WatchdogData {
  let resetCause = undefined;
  let details = undefined;
  
  if (payload.parsed) {
    resetCause = payload.parsed.resetCause;
    details = payload.parsed.details || payload.parsed.message;
  }
  
  return {
    timestamp: event.eventTime,
    eventName: event.eventName,
    resetCause,
    details,
  };
}

/**
 * Extract status data
 */
function extractStatus(event: DynamoIndexRecord, payload: S3StorageRecord): StatusData {
  let data = null;
  if (payload.parsed?.data) {
    data = parsePayloadData(payload.parsed.data);
  }
  if (!data && payload.particle?.data) {
    data = parsePayloadData(payload.particle.data);
  }
  
  return {
    timestamp: event.eventTime,
    eventName: event.eventName,
    cloudRecoverStage: data?.cloudRecoverStage,
    networkState: data?.networkState,
    queueDepth: data?.queueDepth,
    details: data ? JSON.stringify(data) : undefined,
  };
}

/**
 * Extract serial lifecycle data
 */
function extractSerialLifecycle(event: DynamoIndexRecord): SerialLifecycleData {
  let eventType: SerialLifecycleData['eventType'] = 'OTHER';
  const sourceEventType = event.sourceEventType || event.eventType || event.eventName;
  
  if (sourceEventType === 'SERIAL_CONNECTED') eventType = 'SERIAL_CONNECTED';
  else if (sourceEventType === 'SERIAL_DISCONNECTED') eventType = 'SERIAL_DISCONNECTED';
  else if (sourceEventType === 'SERIAL_MISSING') eventType = 'SERIAL_MISSING';
  else if (event.logLine?.includes('MODEM_HEALTH')) eventType = 'MODEM_HEALTH';
  
  return {
    timestamp: event.eventTime,
    eventName: event.eventName,
    eventType,
    details: event.logLine,
  };
}

/**
 * Categorize serial log
 */
function categorizeSerialLog(logLine: string): SerialLogData['category'] {
  const lower = logLine.toLowerCase();
  
  // Check for reconnect/retry first before checking for 'connect'
  if (lower.includes('reconnect') || lower.includes('retry')) return 'reconnect';
  if (lower.includes('modem') || lower.includes('cellular')) return 'modem';
  if (lower.includes('network') || lower.includes('connect')) return 'network';
  if (lower.includes('power') || lower.includes('battery')) return 'power';
  if (lower.includes('error') || lower.includes('fail')) return 'error';
  
  return 'other';
}

/**
 * Extract serial log data
 */
function extractSerialLog(event: DynamoIndexRecord): SerialLogData {
  return {
    timestamp: event.eventTime,
    logLine: event.logLine || '',
    category: categorizeSerialLog(event.logLine || ''),
  };
}

/**
 * Group events into time windows
 */
function groupIntoWindows(events: DynamoIndexRecord[], windowMinutes: number): DynamoIndexRecord[][] {
  if (events.length === 0) return [];
  
  const windows: DynamoIndexRecord[][] = [];
  let currentWindow: DynamoIndexRecord[] = [events[0]];
  let windowStart = new Date(events[0].eventTime);
  
  for (let i = 1; i < events.length; i++) {
    const eventTime = new Date(events[i].eventTime);
    const minutesSinceWindowStart = (eventTime.getTime() - windowStart.getTime()) / (1000 * 60);
    
    if (minutesSinceWindowStart <= windowMinutes) {
      currentWindow.push(events[i]);
    } else {
      windows.push(currentWindow);
      currentWindow = [events[i]];
      windowStart = eventTime;
    }
  }
  
  if (currentWindow.length > 0) {
    windows.push(currentWindow);
  }
  
  return windows;
}

/**
 * Apply correlation heuristics to generate inferences
 */
function generateInferences(window: CorrelationWindow): Inference[] {
  const inferences: Inference[] = [];
  
  // Rule 1: connecttime rising + modem errors = connectivity degradation
  if (window.telemetry.length > 0 && window.serialLogs.length > 0) {
    const highConnectTime = window.telemetry.some(t => t.connecttime && t.connecttime > 60);
    const modemErrors = window.serialLogs.some(log => 
      log.category === 'modem' || log.category === 'error'
    );
    
    if (highConnectTime && modemErrors) {
      inferences.push({
        severity: 'WARNING',
        category: 'connectivity',
        message: 'Connectivity degradation detected: High connection time with modem errors',
        evidence: [
          ...window.telemetry.filter(t => t.connecttime && t.connecttime > 60).map(t => 
            `connecttime=${t.connecttime}s at ${t.timestamp}`
          ),
          ...window.serialLogs.filter(log => log.category === 'modem' || log.category === 'error').map(log => 
            `${log.category}: ${log.logLine.substring(0, 60)}`
          ),
        ],
      });
    }
  }
  
  // Rule 2: repeated SERIAL_CONNECTED/DISCONNECTED = USB instability
  const connectEvents = window.serialLifecycle.filter(s => s.eventType === 'SERIAL_CONNECTED').length;
  const disconnectEvents = window.serialLifecycle.filter(s => s.eventType === 'SERIAL_DISCONNECTED').length;
  
  if (connectEvents > 1 || disconnectEvents > 1) {
    inferences.push({
      severity: 'WARNING',
      category: 'hardware',
      message: `USB instability detected: ${connectEvents} connect, ${disconnectEvents} disconnect events`,
      evidence: window.serialLifecycle.map(s => 
        `${s.eventType} at ${s.timestamp}`
      ),
    });
  }
  
  // Rule 3: watchdog near high connecttime = probable network stall
  if (window.watchdog.length > 0 && window.telemetry.length > 0) {
    const highConnectTime = window.telemetry.some(t => t.connecttime && t.connecttime > 120);
    
    if (highConnectTime) {
      inferences.push({
        severity: 'CRITICAL',
        category: 'connectivity',
        message: 'Network stall likely caused watchdog reset',
        evidence: [
          ...window.watchdog.map(w => `watchdog: ${w.resetCause || w.eventName} at ${w.timestamp}`),
          ...window.telemetry.filter(t => t.connecttime && t.connecttime > 120).map(t => 
            `connecttime=${t.connecttime}s at ${t.timestamp}`
          ),
        ],
      });
    }
  }
  
  // Rule 4: reset count increase + watchdog = reboot event
  if (window.watchdog.length > 0 && window.telemetry.length > 1) {
    const resetCounts = window.telemetry.filter(t => t.resets !== undefined).map(t => t.resets!);
    if (resetCounts.length > 1) {
      const resetIncrease = resetCounts[resetCounts.length - 1] - resetCounts[0];
      if (resetIncrease > 0) {
        inferences.push({
          severity: 'CRITICAL',
          category: 'stability',
          message: `Device reboot detected: reset count increased by ${resetIncrease}`,
          evidence: [
            ...window.watchdog.map(w => `watchdog: ${w.resetCause || w.eventName}`),
            `reset count: ${resetCounts[0]} → ${resetCounts[resetCounts.length - 1]}`,
          ],
        });
      }
    }
  }
  
  // Rule 5: alerts non-zero + low battery = power anomaly
  if (window.telemetry.length > 0) {
    const lowBattery = window.telemetry.some(t => t.battery && t.battery < 30);
    const activeAlerts = window.telemetry.some(t => t.alerts && t.alerts > 0);
    
    if (lowBattery && activeAlerts) {
      inferences.push({
        severity: 'CRITICAL',
        category: 'power',
        message: 'Power anomaly: Low battery with active alerts',
        evidence: window.telemetry
          .filter(t => (t.battery && t.battery < 30) || (t.alerts && t.alerts > 0))
          .map(t => `battery=${t.battery}%, alerts=${t.alerts} at ${t.timestamp}`),
      });
    }
  }
  
  // Rule 6: Reconnect loop detection
  const reconnectLogs = window.serialLogs.filter(log => log.category === 'reconnect');
  if (reconnectLogs.length >= 2) {
    inferences.push({
      severity: 'WARNING',
      category: 'connectivity',
      message: `Reconnect loop detected: ${reconnectLogs.length} reconnect attempts`,
      evidence: reconnectLogs.map(log => `${log.logLine.substring(0, 60)} at ${log.timestamp}`),
    });
  }
  
  // Rule 7: High connection time alone
  if (window.telemetry.length > 0) {
    const veryHighConnectTime = window.telemetry.filter(t => t.connecttime && t.connecttime > 180);
    if (veryHighConnectTime.length > 0 && inferences.filter(i => i.category === 'connectivity').length === 0) {
      inferences.push({
        severity: 'WARNING',
        category: 'connectivity',
        message: 'High cellular connection time detected',
        evidence: veryHighConnectTime.map(t => 
          `connecttime=${t.connecttime}s at ${t.timestamp}`
        ),
      });
    }
  }
  
  // Rule 8: Low battery alone
  if (window.telemetry.length > 0) {
    const criticalBattery = window.telemetry.filter(t => t.battery && t.battery < 20);
    if (criticalBattery.length > 0 && inferences.filter(i => i.category === 'power').length === 0) {
      inferences.push({
        severity: 'CRITICAL',
        category: 'power',
        message: 'Critical battery level detected',
        evidence: criticalBattery.map(t => `battery=${t.battery}% at ${t.timestamp}`),
      });
    }
  }
  
  return inferences;
}

/**
 * Correlate events in a single time window
 */
async function correlateWindow(
  events: DynamoIndexRecord[],
  payloads: Map<string, S3StorageRecord>
): Promise<CorrelationWindow> {
  if (events.length === 0) {
    return {
      startTime: '',
      endTime: '',
      durationMinutes: 0,
      events: [],
      telemetry: [],
      watchdog: [],
      status: [],
      serialLifecycle: [],
      serialLogs: [],
      inferences: [],
    };
  }
  
  const startTime = events[0].eventTime;
  const endTime = events[events.length - 1].eventTime;
  const durationMinutes = (new Date(endTime).getTime() - new Date(startTime).getTime()) / (1000 * 60);
  
  const telemetry: TelemetryData[] = [];
  const watchdog: WatchdogData[] = [];
  const status: StatusData[] = [];
  const serialLifecycle: SerialLifecycleData[] = [];
  const serialLogs: SerialLogData[] = [];
  
  for (const event of events) {
    const type = classifyEvent(event);
    const payload = payloads.get(event.s3Key);
    
    if (type === 'telemetry' && payload) {
      const tel = extractTelemetry(event, payload);
      if (tel) telemetry.push(tel);
    } else if (type === 'watchdog' && payload) {
      watchdog.push(extractWatchdog(event, payload));
    } else if (type === 'status' && payload) {
      status.push(extractStatus(event, payload));
    } else if (type === 'serial-lifecycle') {
      serialLifecycle.push(extractSerialLifecycle(event));
    } else if (type === 'serial-log') {
      serialLogs.push(extractSerialLog(event));
    }
  }
  
  const window: CorrelationWindow = {
    startTime,
    endTime,
    durationMinutes: parseFloat(durationMinutes.toFixed(1)),
    events,
    telemetry,
    watchdog,
    status,
    serialLifecycle,
    serialLogs,
    inferences: [],
  };
  
  window.inferences = generateInferences(window);
  
  return window;
}

/**
 * Perform correlation analysis on device timeline
 */
export async function correlateEvents(
  deviceId: string,
  events: DynamoIndexRecord[],
  payloads: Map<string, S3StorageRecord>,
  windowMinutes: number = 5
): Promise<CorrelationAnalysis> {
  if (events.length === 0) {
    return {
      deviceId,
      startTime: '',
      endTime: '',
      windowCount: 0,
      windowDurationMinutes: windowMinutes,
      windows: [],
      summary: {
        totalInferences: 0,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        topCategories: {},
      },
    };
  }
  
  const eventGroups = groupIntoWindows(events, windowMinutes);
  const windows: CorrelationWindow[] = [];
  
  for (const group of eventGroups) {
    const window = await correlateWindow(group, payloads);
    windows.push(window);
  }
  
  // Calculate summary statistics
  let totalInferences = 0;
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  const topCategories: Record<string, number> = {};
  
  for (const window of windows) {
    for (const inference of window.inferences) {
      totalInferences++;
      if (inference.severity === 'CRITICAL') criticalCount++;
      else if (inference.severity === 'WARNING') warningCount++;
      else infoCount++;
      
      topCategories[inference.category] = (topCategories[inference.category] || 0) + 1;
    }
  }
  
  return {
    deviceId,
    startTime: events[0].eventTime,
    endTime: events[events.length - 1].eventTime,
    windowCount: windows.length,
    windowDurationMinutes: windowMinutes,
    windows,
    summary: {
      totalInferences,
      criticalCount,
      warningCount,
      infoCount,
      topCategories,
    },
  };
}
