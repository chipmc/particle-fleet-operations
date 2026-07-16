'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  normalizeSeverity,
  presentEvent,
  presentObservation,
} = require('./event-presentation');

const {
  TransientWatchError,
  buildSerialEntries,
  buildFleetSummary,
  buildWatchEntries,
  classifyTimelineEvent,
  collectNewTimelineEvents,
  createSerialRenderer,
  createSerialState,
  createWatchState,
  detectCurrentStateChanges,
  enrichDeviceNames,
  fleetSummaryJson,
  fetchTimeline,
  fetchSerialTimeline,
  formatDuration,
  formatRelativeTime,
  formatSerialEntry,
  formatWatchEntry,
  getWatchBannerLines,
  isDeviceId,
  loadDeviceInventory,
  loadLocalOperatorConfig,
  parseEnvFile,
  parseOptions,
  queryTimelineFromDynamo,
  renderFleetSummary,
  resolveDeviceSelector,
  runSerialLoop,
  runWatchLoop,
  timelineLookbackHours,
  timelinePresentationRows,
  watchEntryFromEvent,
} = require('./telemetry');

const telemetryPath = path.join(__dirname, 'telemetry');

function runTelemetry(args) {
  return spawnSync(process.execPath, [telemetryPath, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
  });
}

function watchOptions(overrides = {}) {
  return {
    json: false,
    sinceMs: 0,
    intervalSeconds: 3,
    includeTypes: null,
    excludeTypes: new Set(),
    serialOnly: false,
    raw: false,
    ...overrides,
  };
}

function serialOptions(overrides = {}) {
  return watchOptions({
    sinceMs: 60 * 60 * 1000,
    follow: false,
    includeCollector: false,
    grep: null,
    until: null,
    limit: 25,
    ...overrides,
  });
}

function event(overrides = {}) {
  const result = {
    eventTime: '2026-07-14T08:00:00.000Z',
    eventName: 'Ubidots-Sensor-Hook-v1',
    eventId: 'event-1',
    s3Key: 's3/event-1',
    eventType: 'telemetry.occupancy',
    plane: 'telemetry',
    occupancy: 14,
    battery: 87,
    ...overrides,
  };
  if (overrides.eventName === 'serialLog' && !Object.prototype.hasOwnProperty.call(overrides, 'eventType')) {
    result.eventType = 'serial.log';
  }
  if (overrides.eventName === 'serialLog' && !Object.prototype.hasOwnProperty.call(overrides, 'plane')) {
    result.plane = 'serial';
  }
  return result;
}

function dynamoItem(overrides = {}) {
  return {
    deviceId: { S: overrides.deviceId || 'device123' },
    eventTime: { S: overrides.eventTime || '2026-07-14T08:00:00.000Z' },
    eventName: { S: overrides.eventName || 'serialLog' },
    eventId: { S: overrides.eventId || 'event-1' },
    s3Key: { S: overrides.s3Key || 's3/event-1' },
    eventType: { S: overrides.eventType || 'serial.log' },
    plane: { S: overrides.plane || 'serial' },
    serialLogLine: { S: overrides.serialLogLine || 'boot' },
  };
}

test('presenter classifies serial.log as SERIAL', () => {
  assert.equal(presentEvent(event({ eventType: 'serial.log', plane: 'serial' })).kind, 'SERIAL');
});

test('presenter corrects path-only serial-forwarder LOG records to COLLECTOR', () => {
  const presentation = presentEvent(event({
    eventName: 'serialLog',
    eventType: 'serial.log',
    plane: 'serial',
    serialLogLine: '/dev/serial/by-id/usb-Particle_Boron_123-if00',
  }));
  assert.equal(presentation.kind, 'COLLECTOR');
  assert.equal(presentation.summary, 'Serial device connected: /dev/serial/by-id/usb-Particle_Boron_123-if00');
});

test('presenter classifies serial.lifecycle.connected as COLLECTOR', () => {
  const presentation = presentEvent(event({
    eventName: 'serialLog',
    eventType: 'serial.lifecycle.connected',
    plane: 'serial',
    serialLogLine: '/dev/serial/by-id/usb-Particle_Boron',
  }));
  assert.equal(presentation.kind, 'COLLECTOR');
  assert.equal(presentation.summary, 'Serial device connected: /dev/serial/by-id/usb-Particle_Boron');
});

test('presenter classifies serial.lifecycle.disconnected as COLLECTOR', () => {
  assert.equal(presentEvent(event({ eventType: 'serial.lifecycle.disconnected', plane: 'serial' })).kind, 'COLLECTOR');
});

test('presenter classifies serial.lifecycle.missing as COLLECTOR', () => {
  assert.equal(presentEvent(event({ eventType: 'serial.lifecycle.missing', plane: 'serial' })).kind, 'COLLECTOR');
});

test('presenter preserves normalized collector warning and error severity', () => {
  assert.equal(presentEvent(event({ eventType: 'serial.lifecycle.disconnected', severity: 'WARN' })).severity, 'warning');
  assert.equal(presentEvent(event({ eventType: 'collector.serial.error', severity: 'ERROR' })).severity, 'error');
  assert.equal(normalizeSeverity('CRITICAL'), 'critical');
});

test('presenter classifies Particle status as LIFECYCLE', () => {
  assert.equal(presentEvent(event({ eventName: 'status', eventType: 'particle.status' })).kind, 'LIFECYCLE');
});

test('presenter creates RUNTIME device-status snapshot records', () => {
  const presentation = presentObservation('RUNTIME', { time: '2026-07-14T08:00:00.000Z' });
  assert.equal(presentation.kind, 'RUNTIME');
  assert.equal(presentation.summary, 'device-status snapshot updated');
});

test('presenter creates DATA device-data snapshot records', () => {
  const presentation = presentObservation('DATA', { time: '2026-07-14T08:00:00.000Z' });
  assert.equal(presentation.kind, 'DATA');
  assert.equal(presentation.summary, 'device-data snapshot updated');
});

test('presenter classifies telemetry events as TELEMETRY', () => {
  assert.equal(presentEvent(event()).kind, 'TELEMETRY');
});

test('presenter classifies explicit watchdog events as WATCHDOG', () => {
  assert.equal(presentEvent(event({ eventName: 'watchdog', eventType: 'fault.watchdog' })).kind, 'WATCHDOG');
});

test('presenter classifies unknown canonical events as EVENT', () => {
  const presentation = presentEvent(event({
    eventName: 'custom',
    eventType: 'custom.event',
    plane: 'forensic',
    occupancy: undefined,
    battery: undefined,
  }));
  assert.equal(presentation.kind, 'EVENT');
  assert.equal(presentation.summary, 'Custom Event');
});

test('presenter prefers serialLogLine over other serial content', () => {
  const presentation = presentEvent(event({
    eventType: 'serial.log',
    serialLogLine: 'canonical line',
    logLine: 'legacy line',
    data: 'data line',
  }));
  assert.equal(presentation.summary, 'canonical line');
});

test('presenter falls back from serialLogLine to logLine', () => {
  const presentation = presentEvent(event({ eventType: 'serial.log', serialLogLine: undefined, logLine: 'legacy line' }));
  assert.equal(presentation.summary, 'legacy line');
});

test('presenter falls back from logLine to string data', () => {
  const presentation = presentEvent(event({ eventType: 'serial.log', serialLogLine: undefined, logLine: undefined, data: 'data line' }));
  assert.equal(presentation.summary, 'data line');
});

test('presenter does not override canonical lifecycle classification from plane=serial', () => {
  const presentation = presentEvent(event({
    eventName: 'serialLog',
    eventType: 'serial.lifecycle.disconnected',
    plane: 'serial',
    serialLogLine: "SerialException('device returned no data')",
  }));
  assert.equal(presentation.kind, 'COLLECTOR');
});

test('presenter preserves exact canonical metadata and includes raw only on request', () => {
  const raw = event({
    deviceId: 'device123',
    deviceName: 'Boron Dev',
    sourceType: 'serial-forwarder',
    eventType: 'serial.lifecycle.connected',
    plane: 'serial',
    severity: 'INFO',
  });
  const presentation = presentEvent(raw, { includeRawEvent: true });

  assert.deepEqual({
    time: presentation.time,
    deviceId: presentation.deviceId,
    deviceName: presentation.deviceName,
    sourcePlane: presentation.sourcePlane,
    eventName: presentation.eventName,
    eventType: presentation.eventType,
    sourceType: presentation.sourceType,
    eventId: presentation.eventId,
    s3Key: presentation.s3Key,
  }, {
    time: raw.eventTime,
    deviceId: raw.deviceId,
    deviceName: raw.deviceName,
    sourcePlane: raw.plane,
    eventName: raw.eventName,
    eventType: raw.eventType,
    sourceType: raw.sourceType,
    eventId: raw.eventId,
    s3Key: raw.s3Key,
  });
  assert.equal(presentation.rawEvent, raw);
  assert.equal(Object.hasOwn(presentEvent(raw), 'rawEvent'), false);
});

function fleetSummaryFixture(overrides = {}) {
  return {
    schema: 'fleet-summary.v1',
    generatedAt: '2026-07-14T08:05:00.000Z',
    productId: '42131',
    coverage: {
      inventory: 2,
      currentState: 2,
      runtimeStatus: 2,
      deviceData: 2,
      ...(overrides.coverage || {}),
    },
    connected: { connected: 1, disconnected: 1, unknown: 0 },
    distributions: {
      firmware: [{ value: '14', count: 2 }],
      deviceOs: [{ value: '5.8.0', count: 2 }],
    },
    devices: [
      {
        deviceId: 'device-a',
        deviceName: 'Counter A',
        connected: true,
        firmwareVersion: '14',
        deviceOsVersion: '5.8.0',
        runtimeConnectionState: 'connected',
        lastEventTime: '2026-07-14T08:00:00.000Z',
        lastHeard: '2026-07-14T08:03:00.000Z',
        coverage: { productInventory: true, currentState: true, runtimeStatus: true, deviceData: true },
        metadata: {
          lastEventType: 'telemetry.occupancy',
          deviceStatusLedgerUpdatedAt: '2026-07-14T08:04:00.000Z',
        },
      },
      {
        deviceId: 'device-b',
        deviceName: 'Counter B',
        connected: false,
        firmwareVersion: '14',
        deviceOsVersion: '5.8.0',
        runtimeConnectionState: null,
        lastEventTime: '2026-07-14T07:00:00.000Z',
        lastHeard: null,
        coverage: { productInventory: true, currentState: true, runtimeStatus: true, deviceData: true },
        metadata: {
          lastEventType: 'telemetry.occupancy',
          deviceStatusLedgerUpdatedAt: null,
        },
      },
    ],
    ...overrides,
  };
}

test('top-level help exits successfully without external configuration', () => {
  for (const args of [['--help'], ['help']]) {
    const result = runTelemetry(args);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:[\s\S]*\.\/tools\/telemetry watch <name-or-device-id>/);
    assert.doesNotMatch(result.stderr, /AWS|region|credentials/i);
  }
});

test('watch help exits successfully without external configuration', () => {
  for (const args of [['watch', '--help'], ['help', 'watch']]) {
    const result = runTelemetry(args);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:[\s\S]*\.\/tools\/telemetry watch <name-or-device-id>/);
    assert.match(result.stdout, /--interval <seconds>/);
    assert.doesNotMatch(result.stderr, /AWS|region|credentials/i);
  }
});

test('serial help exits successfully without external configuration', () => {
  for (const args of [['serial', '--help'], ['help', 'serial']]) {
    const result = runTelemetry(args);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /cloud-forwarded serial output/);
    assert.match(result.stdout, /--since <duration>/);
    assert.match(result.stdout, /--follow/);
    assert.match(result.stdout, /--include-collector/);
    assert.doesNotMatch(result.stderr, /AWS|region|credentials/i);
  }
});

test('command help exits successfully without external configuration', () => {
  const result = runTelemetry(['timeline', '--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Timeline lookback window/);
  assert.doesNotMatch(result.stderr, /AWS|region|credentials/i);
});

test('fleet help exits successfully without external configuration', () => {
  for (const args of [['fleet', '--help'], ['help', 'fleet']]) {
    const result = runTelemetry(args);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /fleet-summary\.v1/);
    assert.match(result.stdout, /--product-id <id>/);
    assert.match(result.stdout, /CS\s+Current State/);
    assert.match(result.stdout, /RT\s+Runtime Status/);
    assert.match(result.stdout, /DD\s+Device Data/);
    assert.match(result.stdout, /Online or Offline is not equivalent to device health/);
    assert.doesNotMatch(result.stderr, /AWS|region|credentials/i);
  }
});

test('unknown commands fail before external configuration is loaded', () => {
  const result = runTelemetry(['frobnicate']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: Unknown command: frobnicate/);
  assert.doesNotMatch(result.stderr, /AWS region|credentials|CloudFormation/i);
});

test('Particle-resolved name works for device selector resolution', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ name: 'Boron-Dev-09' }),
  });

  try {
    const devices = [{
      projectId: 'generalized-core-counter',
      deviceId: 'e00fce68399ee6244a963935',
      lastEventTime: '2026-07-13T12:59:59.369Z',
    }];
    const context = {
      particleAccessToken: 'test-token',
      particleApiBaseUrl: 'https://particle.example.test',
      nameCache: new Map(),
    };

    await enrichDeviceNames(context, devices, { required: false });

    assert.equal(devices[0].deviceName, 'Boron-Dev-09');
    assert.equal(isDeviceId('Boron-Dev-09'), false);
    assert.equal(resolveDeviceSelector(devices, 'Boron-Dev-09').deviceId, 'e00fce68399ee6244a963935');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Particle-resolved name works for timeline selector resolution', async () => {
  const devices = [{
    projectId: 'generalized-core-counter',
    deviceId: 'e00fce68399ee6244a963935',
    deviceName: 'Boron-Dev-09',
    lastEventTime: '2026-07-13T12:59:59.369Z',
  }];

  assert.equal(resolveDeviceSelector(devices, 'boron-dev-09').deviceId, 'e00fce68399ee6244a963935');
  assert.equal(resolveDeviceSelector(devices, 'Boron-Dev').deviceId, 'e00fce68399ee6244a963935');
});

test('ambiguous partial names list matching names and ids', () => {
  const devices = [
    { deviceId: 'e00fce68399ee6244a963935', deviceName: 'Boron-Dev-09' },
    { deviceId: 'e00fce688e592afaf23ac4fb', deviceName: 'Boron-Dev-10' },
  ];

  assert.throws(
    () => resolveDeviceSelector(devices, 'boron-dev'),
    /Ambiguous device selector: boron-dev[\s\S]*Boron-Dev-09[\s\S]*Boron-Dev-10/
  );
});

test('watch resolves exact device IDs with the shared selector', () => {
  const devices = [{ deviceId: 'e00fce68399ee6244a963935', deviceName: 'Boron-Dev-09' }];

  assert.equal(resolveDeviceSelector(devices, 'e00fce68399ee6244a963935').deviceName, 'Boron-Dev-09');
});

test('serial uses shared device-name and device-ID selector resolution', () => {
  const devices = [{ deviceId: '0123456789abcdef01234567', deviceName: 'Boron-soak-1' }];

  assert.equal(resolveDeviceSelector(devices, 'Boron-soak-1').deviceId, '0123456789abcdef01234567');
  assert.equal(resolveDeviceSelector(devices, '0123456789abcdef01234567').deviceName, 'Boron-soak-1');
});

test('name and ID selectors produce identical resolved-device queries', () => {
  const devices = [{ deviceId: 'e00fce68399ee6244a963935', deviceName: 'Boron-Dev-09' }];

  assert.equal(resolveDeviceSelector(devices, 'Boron-Dev-09').deviceId, resolveDeviceSelector(devices, 'e00fce68399ee6244a963935').deviceId);
});

test('watch option parsing supports interval, since, filters, json, and raw', () => {
  const options = parseOptions(['--interval', '2.5', '--since', '5m', '--types', 'serial,status', '--exclude', 'event', '--json', '--raw', 'P2-NewCode-Dev']);

  assert.equal(options.intervalSeconds, 2.5);
  assert.equal(options.sinceMs, 300000);
  assert.deepEqual([...options.includeTypes].sort(), ['SERIAL', 'STATUS']);
  assert.deepEqual([...options.excludeTypes], ['EVENT']);
  assert.equal(options.json, true);
  assert.equal(options.raw, true);
  assert.deepEqual(options.positionals, ['P2-NewCode-Dev']);
});

test('serial option parsing supports since, until, follow, collector, grep, json, raw, and limit', () => {
  const options = parseOptions(['--since', '1h', '--until', '2026-07-14T08:00:00.000Z', '--follow', '--include-collector', '--grep', 'boot', '--json', '--full', '--limit', '7']);

  assert.equal(options.sinceMs, 60 * 60 * 1000);
  assert.equal(options.until, '2026-07-14T08:00:00.000Z');
  assert.equal(options.follow, true);
  assert.equal(options.includeCollector, true);
  assert.equal(options.grep, 'boot');
  assert.equal(options.json, true);
  assert.equal(options.raw, true);
  assert.equal(options.limit, 7);
});

test('timeline --since overrides the default 24-hour lookback', () => {
  const options = parseOptions(['--since', '1h', 'Boron-Dev-09']);
  assert.equal(timelineLookbackHours(options), 1);
  assert.equal(timelineLookbackHours(parseOptions(['--since', '30m', 'Boron-Dev-09'])), 0.5);
  assert.equal(timelineLookbackHours(parseOptions(['--hours', '6', 'Boron-Dev-09'])), 6);
});

test('timeline API request sends the --since lookback instead of default hours', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ events: [], count: 0 }),
    };
  };

  try {
    await fetchTimeline({ webhookSecret: 'secret', queryApiBaseUrl: 'https://query.example.test' }, 'device123', {
      ...parseOptions(['--since', '1h', 'Boron-Dev-09']),
      limit: 25,
    });
    assert.match(requestedUrl, /[?&]hours=1(?:&|$)/);
    assert.doesNotMatch(requestedUrl, /[?&]hours=24(?:&|$)/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fleet option parsing supports product id, transport allowance, and verbose', () => {
  const options = parseOptions(['--product-id', '42131', '--activity-limit', '4', '--transport-allowance', '2m', '--verbose', '--json']);

  assert.equal(options.productId, '42131');
  assert.equal(options.activityLimit, 4);
  assert.equal(options.transportAllowanceSeconds, 120);
  assert.equal(options.verbose, true);
  assert.equal(options.json, true);
});

test('local operator config prefers environment token over secrets file', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-home-'));
  fs.mkdirSync(path.join(homeDir, '.particle-log-monitoring'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.particle-log-monitoring', 'secrets.env'), [
    'PARTICLE_ACCESS_TOKEN=file-token',
    'PARTICLE_WEBHOOK_SECRET=file-webhook-secret',
    'PARTICLE_API_BASE_URL=https://particle.file.test',
  ].join('\n'));

  const config = loadLocalOperatorConfig({
    PARTICLE_ACCESS_TOKEN: 'env-token',
  }, homeDir);

  assert.deepEqual(config, {
    PARTICLE_ACCESS_TOKEN: 'env-token',
    PARTICLE_WEBHOOK_SECRET: 'file-webhook-secret',
    PARTICLE_API_BASE_URL: 'https://particle.file.test',
  });
});

test('secrets env parser supports export and quoted values', () => {
  assert.deepEqual(parseEnvFile(`
# local operator cache
export PARTICLE_ACCESS_TOKEN="file-token"
PARTICLE_WEBHOOK_SECRET='webhook-secret'
PARTICLE_API_BASE_URL=https://particle.example.test
`), {
    PARTICLE_ACCESS_TOKEN: 'file-token',
    PARTICLE_WEBHOOK_SECRET: 'webhook-secret',
    PARTICLE_API_BASE_URL: 'https://particle.example.test',
  });
});

test('fleet inventory missing token reports local credential guidance', async () => {
  await assert.rejects(
    () => loadDeviceInventory({
      options: { projectId: 'generalized-core-counter' },
      deviceCurrentStateTableName: 'current-state-table',
      particleAccessToken: '',
      particleApiBaseUrl: 'https://particle.example.test',
      nameCache: new Map(),
      awsJson: () => ({ Items: [] }),
    }, { productId: '42131' }),
    (err) => {
      assert.match(err.message, /local PARTICLE_ACCESS_TOKEN/);
      assert.match(err.message, /secrets\.env/);
      assert.doesNotMatch(err.message, /deployed Lambda|token-/i);
      return true;
    }
  );
});

test('fleet summary joins product inventory, current state, and runtime projection', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-a',
      deviceName: 'Counter A',
      productId: '42131',
      hasProductInventory: true,
      hasCurrentState: true,
      fwVersion: '14',
      lastEventTime: '2026-07-14T08:00:00.000Z',
      lastEventType: 'telemetry.occupancy',
      deviceStatusLedgerUpdatedAt: '2026-07-14T08:01:00.000Z',
      deviceStatusLedgerData: { connection: { state: 'connected' } },
      deviceDataLedgerUpdatedAt: '2026-07-14T08:01:30.000Z',
      particle: { connected: true, system_firmware_version: '5.8.0', last_heard: '2026-07-14T08:02:00.000Z' },
    },
    {
      deviceId: 'device-b',
      deviceName: 'Counter B',
      productId: '42131',
      hasProductInventory: true,
      hasCurrentState: false,
      particle: { connected: false, system_firmware_version: '5.7.0' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T08:03:00.000Z' });

  assert.equal(summary.schema, 'fleet-summary.v1');
  assert.deepEqual(summary.coverage, {
    inventory: 2,
    currentState: 1,
    runtimeStatus: 1,
    deviceData: 1,
  });
  assert.deepEqual(summary.connected, { connected: 1, disconnected: 1, unknown: 0 });
  assert.deepEqual(summary.distributions.firmware, [
    { value: '14', count: 1 },
    { value: '<unknown>', count: 1 },
  ]);
  assert.deepEqual(summary.distributions.deviceOs, [
    { value: '5.7.0', count: 1 },
    { value: '5.8.0', count: 1 },
  ]);
  assert.equal(summary.devices[0].runtimeConnectionState, 'connected');
});

test('fleet summary overlays device settings and derives upcoming and overdue application reports', () => {
  const now = new Date('2026-07-14T08:40:00.000Z');
  const productDefaultsLedgerData = {
    timing: {
      reportingIntervalSec: 3600,
      connectAttemptBudgetSec: 300,
      openHour: 6,
    },
  };
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-upcoming',
      deviceName: 'Upcoming Counter',
      hasProductInventory: true,
      hasCurrentState: true,
      lastApplicationReportAt: '2026-07-14T08:10:00.000Z',
      lastEventTime: '2026-07-14T08:25:00.000Z',
      lastPlane: 'serial',
      productDefaultsLedgerData,
      deviceSettingsLedgerData: { timing: { reportingIntervalSec: 1800 } },
      particle: { connected: true },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-overdue',
      deviceName: 'Overdue Counter',
      hasProductInventory: true,
      hasCurrentState: true,
      lastApplicationReportAt: '2026-07-14T07:30:00.000Z',
      lastEventTime: '2026-07-14T07:30:00.000Z',
      lastPlane: 'telemetry',
      productDefaultsLedgerData,
      particle: { connected: false },
    },
  ], {
    productId: '42131',
    generatedAt: now.toISOString(),
    now,
    transportAllowanceSeconds: 60,
  });

  assert.deepEqual({
    reportingIntervalSeconds: summary.devices[0].reportingIntervalSeconds,
    connectionBudgetSeconds: summary.devices[0].connectionBudgetSeconds,
    transportAllowanceSeconds: summary.devices[0].transportAllowanceSeconds,
    expectedNextReport: summary.devices[0].expectedNextReport,
    expectationStatus: summary.devices[0].expectationStatus,
  }, {
    reportingIntervalSeconds: 1800,
    connectionBudgetSeconds: 300,
    transportAllowanceSeconds: 60,
    expectedNextReport: '2026-07-14T08:46:00.000Z',
    expectationStatus: 'upcoming',
  });
  assert.equal(summary.devices[0].lastApplicationReportAt, '2026-07-14T08:10:00.000Z');
  assert.equal(summary.devices[1].expectedNextReport, '2026-07-14T08:36:00.000Z');
  assert.equal(summary.devices[1].expectationStatus, 'overdue');
  assert.ok(summary.attention.find(entry => entry.deviceId === 'device-overdue').observations.includes(
    'Expected application report 4 minutes ago'
  ));

  const plain = renderFleetSummary(summary, { color: false, now, terminalWidth: 180 }).join('\n');
  assert.match(plain, /SOC\s+\| EXPECTED/);
  assert.match(plain, /Upcoming Counter[\s\S]*in 6 min/);
  assert.match(plain, /Overdue Counter[\s\S]*4 min overdue/);
  assert.doesNotMatch(summary.attention.flatMap(entry => entry.observations).join(' '), /health|score|warning|critical/i);
});

test('fleet summary colorizes upcoming expectations green and overdue expectations red', () => {
  const now = new Date('2026-07-14T08:30:00.000Z');
  const defaults = { timing: { reportingIntervalSec: 3600, connectAttemptBudgetSec: 300 } };
  const summary = buildFleetSummary([
    {
      deviceId: 'upcoming',
      deviceName: 'Upcoming',
      hasProductInventory: true,
      hasCurrentState: true,
      lastApplicationReportAt: '2026-07-14T08:00:00.000Z',
      productDefaultsLedgerData: defaults,
      particle: { connected: true },
    },
    {
      deviceId: 'overdue',
      deviceName: 'Overdue',
      hasProductInventory: true,
      hasCurrentState: true,
      lastApplicationReportAt: '2026-07-14T07:20:00.000Z',
      productDefaultsLedgerData: defaults,
      particle: { connected: false },
    },
  ], { now, transportAllowanceSeconds: 60 });

  const output = renderFleetSummary(summary, { color: true, now, terminalWidth: 180 }).join('\n');
  assert.match(output, /\x1b\[32min 36 min\x1b\[39m/);
  assert.match(output, /\x1b\[31m4 min overdue\x1b\[39m/);
});

test('fleet summary JSON omits verbose metadata by default', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-a',
      deviceName: 'Counter A',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventType: 'telemetry.occupancy',
      particle: { connected: true },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T08:03:00.000Z' });

  assert.equal(fleetSummaryJson(summary, { verbose: false }).devices[0].metadata, undefined);
  assert.deepEqual(fleetSummaryJson(summary, { verbose: false }).coverage, {
    inventory: 1,
    currentState: 1,
    runtimeStatus: 0,
    deviceData: 0,
  });
  assert.equal(fleetSummaryJson(summary, { verbose: true }).devices[0].metadata.lastEventType, 'telemetry.occupancy');
});

test('fleet summary reports additive battery SOC facts from Ledger SOC with telemetry fallback', () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-a',
      deviceName: 'Counter A',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:55:00.000Z',
      battery: 12,
      deviceStatusLedgerUpdatedAt: '2026-07-14T05:00:00.000Z',
      deviceStatusLedgerData: { battery: { soc: 79.1 }, connection: { state: 'connected' } },
      particle: { connected: true, last_heard: '2026-07-14T11:55:00.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-b',
      deviceName: 'Counter B',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:30:00.000Z',
      battery: 42.56,
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:30:00.000Z',
      deviceStatusLedgerData: { connection: { state: 'connected' } },
      particle: { connected: true, last_heard: '2026-07-14T11:30:00.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-c',
      deviceName: 'Counter C',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:57:00.000Z',
      battery: 0,
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:45:00.000Z',
      deviceStatusLedgerData: { connection: { state: 'connected' } },
      particle: { connected: true, last_heard: '2026-07-14T11:57:00.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-d',
      deviceName: 'Counter D',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:58:00.000Z',
      battery: -1,
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:50:00.000Z',
      deviceStatusLedgerData: { battery: { soc: 101 }, connection: { state: 'connected' } },
      particle: { connected: false },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-e',
      deviceName: 'Counter E',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:59:00.000Z',
      battery: 50,
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:55:00.000Z',
      deviceStatusLedgerData: { battery: { soc: '50' }, connection: { state: 'connected' } },
      particle: { connected: true, last_heard: '2026-07-14T11:59:00.000Z' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T12:00:00.000Z', now });

  assert.deepEqual(summary.batterySoc, {
    observed: 4,
    inventory: 5,
    unknown: 1,
    lowest: 0,
    median: 46.28,
  });
  assert.deepEqual(summary.devices.map(device => [device.deviceName, device.socPercent, device.socObservedAt, device.socSource]), [
    ['Counter A', 79.1, '2026-07-14T05:00:00.000Z', 'device-status'],
    ['Counter B', 42.56, '2026-07-14T11:30:00.000Z', 'telemetry'],
    ['Counter C', 0, '2026-07-14T11:57:00.000Z', 'telemetry'],
    ['Counter D', null, null, null],
    ['Counter E', 50, '2026-07-14T11:59:00.000Z', 'telemetry'],
  ]);
  assert.deepEqual(summary.attention.find(entry => entry.deviceName === 'Counter A')?.observations, [
    'Last reported SOC 79%',
    'SOC observation is 7 hr old',
  ]);

  const json = fleetSummaryJson(summary, { verbose: false });
  assert.equal(json.devices[0].socPercent, 79.1);
  assert.equal(json.devices[0].socObservedAt, '2026-07-14T05:00:00.000Z');
  assert.equal(json.devices[0].socSource, 'device-status');
  assert.equal(json.devices[1].socPercent, 42.56);
  assert.equal(json.devices[1].socSource, 'telemetry');
  assert.equal(json.devices[2].socPercent, 0);
  assert.equal(json.devices[3].socPercent, null);
  assert.equal(json.batterySoc.lowest, 0);
  assert.equal(json.batterySoc.median, 46.28);

  const output = renderFleetSummary(summary, { color: false, now, terminalWidth: 160, verbose: true }).join('\n');
  assert.match(output, /BATTERY SOC[\s\S]*Observed\s+4 \/ 5[\s\S]*Lowest\s+0%[\s\S]*Median\s+46%[\s\S]*Unknown\s+1/);
  assert.match(output, /SOC/);
  assert.match(output, /Counter A[\s\S]*79%[\s\S]*2026-07-14T05:00:00\.000Z[\s\S]*device-status/);
  assert.match(output, /Counter B[\s\S]*43%[\s\S]*2026-07-14T11:30:00\.000Z[\s\S]*telemetry/);
  assert.match(output, /Counter C[\s\S]*0%[\s\S]*2026-07-14T11:57:00\.000Z[\s\S]*telemetry/);
  assert.doesNotMatch(summary.attention.map(entry => entry.observations.join(' ')).join(' '), /healthy|low|warning|critical/i);
});

test('fleet summary JSON includes optional attention observations', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-a',
      deviceName: 'Counter A',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T02:05:00.000Z',
      particle: { connected: true, last_heard: '2026-07-14T02:05:00.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-b',
      deviceName: 'Counter B',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T08:00:00.000Z',
      deviceDataLedgerUpdatedAt: '2026-07-14T08:01:00.000Z',
      particle: { connected: true, last_heard: '2026-07-14T08:00:00.000Z' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T08:05:00.000Z', now: new Date('2026-07-14T08:05:00.000Z') });

  assert.deepEqual(fleetSummaryJson(summary, { verbose: false }).attention, [
    {
      deviceId: 'device-a',
      deviceName: 'Counter A',
      observations: [
        'Last heard 6 hours ago',
        'Runtime status not yet observed',
        'Device Data not observed',
      ],
    },
    {
      deviceId: 'device-b',
      deviceName: 'Counter B',
      observations: [
        'Last heard 5 minutes ago',
        'Runtime status not yet observed',
      ],
    },
  ]);
  assert.deepEqual(fleetSummaryJson(summary, { verbose: false }).recentActivity.map(entry => [entry.deviceName, entry.summary]), [
    ['Counter B', 'Event'],
    ['Counter A', 'Event'],
  ]);
});


test('fleet summary JSON includes an empty attention list when no observations apply', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-a',
      deviceName: 'Counter A',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T08:00:00.000Z',
      deviceStatusLedgerUpdatedAt: '2026-07-14T08:01:00.000Z',
      particle: { connected: true, last_heard: '2026-07-14T08:00:00.000Z' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T08:05:00.000Z' });

  assert.deepEqual(fleetSummaryJson(summary, { verbose: false }).attention, []);
});

test('fleet text renders compact overview, evidence columns, relative last heard, and empty attention', () => {
  const lines = renderFleetSummary(fleetSummaryFixture(), {
    now: new Date('2026-07-14T08:05:00.000Z'),
    color: false,
    terminalWidth: 120,
  });
  const output = lines.join('\n');

  assert.match(output, /COVERAGE\s+CLOUD\s+FIRMWARE\s+DEVICE OS/);
  assert.match(output, /Inventory\s+2 \/ 2\s+Online\s+1\s+14\s+2\s+5\.8\.0\s+2/);
  assert.match(output, /Current State\s+2 \/ 2\s+Offline\s+1/);
  assert.match(output, /Device Data\s+2 \/ 2 \(100%\)/);
  assert.match(output, /Recent Activity\n---------------\n[\s\S]*TELEMETRY\s+Counter A Occupancy report[\s\S]*TELEMETRY\s+Counter B Occupancy report/);
  assert.match(output, /NAME\s+\| DEVICE ID\s+\| CS \| RT \| DD \| CLOUD/);
  assert.match(output, /Counter A[\s\S]*\| Y\s+\| Y\s+\| Y\s+\| Online[\s\S]*\| 2 min ago\s+\| Observed/);
  assert.match(output, /Counter B[\s\S]*\| Y\s+\| Y\s+\| Y\s+\| Offline[\s\S]*\| 1 hr ago\s+\| Observed/);
  assert.doesNotMatch(output, /LAST SEEN/);
  assert.doesNotMatch(output, /Connected:/);
  assert.match(output, /Devices Requiring Attention\n---------------------------\n\nNAME/);
  assert.ok(output.indexOf('Recent Activity') > output.indexOf('Counter B | device-b'));
});

test('fleet overview renders multiple firmware and Device OS cohorts with uneven section lengths', () => {
  const output = renderFleetSummary(fleetSummaryFixture({
    distributions: {
      firmware: [
        { value: '20', count: 5 },
        { value: '<unknown>', count: 1 },
      ],
      deviceOs: [
        { value: '6.4.1', count: 4 },
        { value: '6.3.3', count: 1 },
        { value: '<unknown>', count: 1 },
      ],
    },
  }), { color: false, terminalWidth: 120 }).join('\n');

  assert.match(output, /COVERAGE\s+CLOUD\s+FIRMWARE\s+DEVICE OS/);
  assert.match(output, /Inventory\s+2 \/ 2\s+Online\s+1\s+20\s+5\s+6\.4\.1\s+4/);
  assert.match(output, /Current State\s+2 \/ 2\s+Offline\s+1\s+<unknown>\s+1\s+6\.3\.3\s+1/);
  assert.match(output, /Runtime Status\s+2 \/ 2\s+Unknown\s+0\s+<unknown>\s+1/);
});

test('fleet overview falls back to stacked layout for narrow terminals', () => {
  const output = renderFleetSummary(fleetSummaryFixture(), { color: false, terminalWidth: 72 }).join('\n');

  assert.match(output, /COVERAGE\n--------\nInventory\s+2 \/ 2/);
  assert.match(output, /CLOUD\n-----\nOnline\s+1\nOffline\s+1\nUnknown\s+0/);
  assert.match(output, /FIRMWARE\n--------\n14\s+2/);
  assert.doesNotMatch(output, /COVERAGE\s+CLOUD\s+FIRMWARE\s+DEVICE OS/);
});

test('fleet verbose text keeps ISO timestamps and additional metadata', () => {
  const output = renderFleetSummary(fleetSummaryFixture(), { verbose: true, color: false }).join('\n');

  assert.match(output, /LAST HEARD/);
  assert.match(output, /PARTICLE HEARD/);
  assert.match(output, /LEDGER UPDATED/);
  assert.match(output, /2026-07-14T08:03:00\.000Z/);
  assert.match(output, /2026-07-14T08:04:00\.000Z/);
});

test('fleet attention groups actionable device observations and suppresses undeployed device data', () => {
  const summary = fleetSummaryFixture({
    coverage: { inventory: 2, currentState: 1, runtimeStatus: 0, deviceData: 0 },
    devices: [
      {
        deviceId: 'device-a',
        deviceName: 'Counter A',
        connected: true,
        firmwareVersion: '14',
        deviceOsVersion: '5.8.0',
        runtimeConnectionState: null,
        lastEventTime: '2026-07-14T02:05:00.000Z',
        lastHeard: '2026-07-14T02:05:00.000Z',
        coverage: { productInventory: true, currentState: true, runtimeStatus: false, deviceData: false },
        metadata: {},
      },
      {
        deviceId: 'device-b',
        deviceName: 'Counter B',
        connected: null,
        firmwareVersion: '14',
        deviceOsVersion: '5.8.0',
        runtimeConnectionState: null,
        lastEventTime: '2026-05-09T08:05:00.000Z',
        lastHeard: null,
        coverage: { productInventory: true, currentState: false, runtimeStatus: false, deviceData: false },
        metadata: {},
      },
    ],
  });
  const output = renderFleetSummary(summary, { color: false, now: new Date('2026-07-14T08:05:00.000Z') }).join('\n');

  assert.match(output, /Device Data\s+Not Enabled/);
  assert.match(output, /Counter A\n  - Last heard 6 hours ago\n  - Runtime status not yet observed/);
  assert.match(output, /Counter B\n  - No Current State\n  - Last heard 66 days ago\n  - Runtime status not yet observed/);
  assert.doesNotMatch(output, /Device Data not observed/);
  assert.match(output, /Counter A[\s\S]*\| Y\s+\| -\s+\| -\s+\| Online[\s\S]*\| 6 hr ago\s+\| Pending/);
  assert.match(output, /Counter B[\s\S]*\| -\s+\| -\s+\| -\s+\| Unknown[\s\S]*\| 66 days ago\s+\| Unknown/);
  assert.deepEqual(fleetSummaryJson(summary, { verbose: false }).coverage, {
    inventory: 2,
    currentState: 1,
    runtimeStatus: 0,
    deviceData: 0,
  });
});

test('fleet attention uses waiting-for-first-telemetry onboarding wording', () => {
  const summary = buildFleetSummary([
    {
      deviceId: 'device-a',
      deviceName: 'Boron-Dev-v11',
      hasProductInventory: true,
      hasCurrentState: false,
      particle: { connected: true, last_heard: '2026-07-14T08:04:12.000Z' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T08:05:00.000Z', now: new Date('2026-07-14T08:05:00.000Z') });

  assert.deepEqual(summary.attention, [{
    deviceId: 'device-a',
    deviceName: 'Boron-Dev-v11',
    observations: [
      'Cloud connected',
      'Waiting for first telemetry',
    ],
  }]);
  assert.match(renderFleetSummary(summary, { color: false }).join('\n'), /Boron-Dev-v11\n  - Cloud connected\n  - Waiting for first telemetry/);
});

test('fleet recent activity is newest first and respects the activity limit', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'older',
      deviceName: 'Older Counter',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T08:00:00.000Z',
      particle: { connected: true },
    },
    {
      deviceId: 'cloud',
      deviceName: 'Boron-Dev-v11',
      hasProductInventory: true,
      hasCurrentState: false,
      particle: { connected: true, last_heard: '2026-07-14T08:04:12.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'newer',
      deviceName: 'Newer Counter',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T08:03:00.000Z',
      lastEventType: 'telemetry.occupancy',
      lastPlane: 'telemetry',
      particle: { connected: true },
    },
  ], { productId: '42131', activityLimit: 2 });

  assert.deepEqual(summary.recentActivity.map(entry => [entry.deviceName, entry.summary]), [
    ['Boron-Dev-v11', 'Connected to Particle Cloud'],
    ['Newer Counter', 'Occupancy report'],
  ]);
  assert.equal(summary.recentActivity.length, 2);
});

test('fleet summary treats recent serial activity and old Particle last_heard as separate evidence planes', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'device-a',
      deviceName: 'boron-soak-1',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:11:00.000Z',
      lastEventType: 'serial.log',
      lastPlane: 'serial',
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:11:30.000Z',
      particle: { connected: false, last_heard: '2026-07-14T07:11:00.000Z' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T11:12:00.000Z', now: new Date('2026-07-14T11:12:00.000Z') });

  assert.equal(summary.devices[0].connected, false);
  assert.equal(summary.devices[0].lastHeard, '2026-07-14T07:11:00.000Z');
  assert.deepEqual(summary.recentActivity.map(entry => ({
    time: entry.time,
    deviceId: entry.deviceId,
    deviceName: entry.deviceName,
    kind: entry.kind,
    summary: entry.summary,
    source: entry.source,
    authority: entry.authority,
    particleLastHeard: entry.particleLastHeard,
  })), [{
    time: '2026-07-14T11:11:00.000Z',
    deviceId: 'device-a',
    deviceName: 'boron-soak-1',
    kind: 'SERIAL',
    summary: 'Serial log event',
    source: 'DeviceCurrentState',
    authority: 'EventHistory projection',
    particleLastHeard: '2026-07-14T07:11:00.000Z',
  }]);
  assert.deepEqual(summary.attention, [{
    deviceId: 'device-a',
    deviceName: 'boron-soak-1',
    observations: ['Recent serial activity; Particle last heard 4 hr ago'],
  }]);
});

test('fleet summary classifies telemetry, lifecycle, and unknown latest events factually', () => {
  const summary = buildFleetSummary([
    {
      projectId: 'generalized-core-counter',
      deviceId: 'telemetry-device',
      deviceName: 'Telemetry Device',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:10:00.000Z',
      lastEventType: 'telemetry.occupancy',
      lastPlane: 'telemetry',
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:10:30.000Z',
      particle: { connected: true, last_heard: '2026-07-14T11:10:05.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'status-device',
      deviceName: 'Status Device',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:09:00.000Z',
      lastEventType: 'telemetry.status',
      lastPlane: 'forensic',
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:09:30.000Z',
      particle: { connected: true, last_heard: '2026-07-14T11:09:05.000Z' },
    },
    {
      projectId: 'generalized-core-counter',
      deviceId: 'unknown-device',
      deviceName: 'Unknown Device',
      hasProductInventory: true,
      hasCurrentState: true,
      lastEventTime: '2026-07-14T11:08:00.000Z',
      lastEventType: 'custom.event',
      lastPlane: 'forensic',
      deviceStatusLedgerUpdatedAt: '2026-07-14T11:08:30.000Z',
      particle: { connected: true, last_heard: '2026-07-14T11:08:05.000Z' },
    },
  ], { productId: '42131', generatedAt: '2026-07-14T11:12:00.000Z', now: new Date('2026-07-14T11:12:00.000Z') });

  assert.deepEqual(summary.recentActivity.map(entry => [entry.deviceName, entry.kind, entry.summary]), [
    ['Telemetry Device', 'TELEMETRY', 'Occupancy report'],
    ['Status Device', 'LIFECYCLE', 'Device status event'],
    ['Unknown Device', 'EVENT', 'Custom Event'],
  ]);
  assert.deepEqual(summary.attention, []);
});

test('fleet Recent Activity presents collector lifecycle without calling it telemetry or firmware serial', () => {
  const summary = buildFleetSummary([{
    projectId: 'generalized-core-counter',
    deviceId: 'collector-device',
    deviceName: 'Collector Device',
    hasProductInventory: true,
    hasCurrentState: true,
    lastEventTime: '2026-07-14T11:11:00.000Z',
    lastEventType: 'serial.lifecycle.disconnected',
    lastPlane: 'serial',
    lastSourceType: 'serial-forwarder',
    deviceStatusLedgerUpdatedAt: '2026-07-14T11:11:30.000Z',
    particle: { connected: false, last_heard: '2026-07-14T11:10:00.000Z' },
  }], { productId: '42131' });

  assert.deepEqual(summary.recentActivity.map(entry => [entry.kind, entry.summary, entry.sourceType]), [
    ['COLLECTOR', 'Serial device disconnected', 'serial-forwarder'],
  ]);
});

test('fleet recent activity can be empty', () => {
  const summary = buildFleetSummary([
    {
      deviceId: 'quiet',
      deviceName: 'Quiet Counter',
      hasProductInventory: true,
      hasCurrentState: false,
      particle: { connected: false },
    },
  ], { productId: '42131' });

  assert.deepEqual(summary.recentActivity, []);
  assert.match(renderFleetSummary(summary, { color: false }).join('\n'), /NAME[\s\S]*Quiet Counter[\s\S]*\n\nRecent Activity\n---------------$/);
});

test('fleet JSON is unchanged by compact text layout options', () => {
  const summary = fleetSummaryFixture();

  assert.deepEqual(fleetSummaryJson(summary, { verbose: false, terminalWidth: 72 }), fleetSummaryJson(summary, { verbose: false, terminalWidth: 120 }));
});

test('fleet text color is optional and disabled for JSON', () => {
  const colored = renderFleetSummary(fleetSummaryFixture(), { color: true }).join('\n');
  const plain = renderFleetSummary(fleetSummaryFixture(), { color: true, json: true }).join('\n');

  assert.match(colored, /\x1b\[32mY\x1b\[39m/);
  assert.doesNotMatch(plain, /\x1b\[/);
});

test('relative time formatter uses compact operator labels', () => {
  const now = new Date('2026-07-14T08:05:00.000Z');

  assert.equal(formatRelativeTime('2026-07-14T08:04:58.000Z', now), '2 sec ago');
  assert.equal(formatRelativeTime('2026-07-14T08:03:00.000Z', now), '2 min ago');
  assert.equal(formatRelativeTime('2026-07-14T03:05:00.000Z', now), '5 hr ago');
});

test('fleet inventory uses product inventory names without duplicate device lookups', async () => {
  const originalFetch = global.fetch;
  const fetchUrls = [];
  global.fetch = async (url) => {
    fetchUrls.push(String(url));
    assert.match(String(url), /\/v1\/products\/42131\/devices/);
    return {
      ok: true,
      json: async () => ({
        devices: [
          { id: 'device-a', name: 'Counter A', connected: true, system_firmware_version: '5.8.0' },
          { id: 'device-b', name: 'Counter B', connected: false, system_firmware_version: '5.7.0' },
        ],
      }),
    };
  };

  try {
    const devices = await loadDeviceInventory({
      options: { projectId: 'generalized-core-counter' },
      deviceCurrentStateTableName: 'current-state-table',
      particleAccessToken: 'test-token',
      particleApiBaseUrl: 'https://particle.example.test',
      nameCache: new Map(),
      awsJson: () => ({
        Items: [{
          projectId: { S: 'generalized-core-counter' },
          deviceId: { S: 'device-a' },
          fwVersion: { S: '14' },
          lastEventTime: { S: '2026-07-14T08:00:00.000Z' },
          deviceStatusLedgerUpdatedAt: { S: '2026-07-14T08:01:00.000Z' },
          deviceStatusLedgerData: { M: { connection: { M: { state: { S: 'connected' } } } } },
        }],
      }),
    }, { productId: '42131' });

    assert.equal(fetchUrls.length, 1);
    assert.deepEqual(devices.map(device => device.deviceName), ['Counter A', 'Counter B']);
    assert.equal(devices[0].hasCurrentState, true);
    assert.equal(devices[1].hasCurrentState, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('watch establishes an initial cursor without printing existing events', () => {
  const state = createWatchState(watchOptions(), new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'a', s3Key: 'a' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'b', s3Key: 'b' }),
  ], null, state, watchOptions());

  assert.deepEqual(entries, []);
  assert.equal(state.cursor.eventTime, '2026-07-14T08:00:02.000Z');
  assert.equal(state.cursor.id, 'b');
});

test('default startup prints no historical Timeline rows but emits initial runtime context', () => {
  const state = createWatchState(watchOptions(), new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'serial', s3Key: 'serial', eventName: 'serialLog', serialLogLine: 'boot' }),
  ], { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:02.000Z' }, state, watchOptions());

  assert.deepEqual(entries.map(entry => [entry.category, entry.summary]), [
    ['RUNTIME', 'device-status snapshot available'],
  ]);
  assert.equal(state.cursor.id, 'serial');
});

test('watch returns new events only and suppresses duplicates', () => {
  const state = createWatchState(watchOptions(), new Date('2026-07-14T08:00:10.000Z'));
  buildWatchEntries([event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'a', s3Key: 'a' })], null, state, watchOptions());

  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'a', s3Key: 'a' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'b', s3Key: 'b', occupancy: 2 }),
  ], null, state, watchOptions());

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event.eventId, 'b');
});

test('watch handles identical timestamps with distinct event IDs', () => {
  const state = { cursor: { eventTime: '2026-07-14T08:00:00.000Z', id: 'a' }, seenEventIds: new Set(['a']) };
  const events = collectNewTimelineEvents([
    event({ eventTime: '2026-07-14T08:00:00.000Z', eventId: 'a', s3Key: 'a' }),
    event({ eventTime: '2026-07-14T08:00:00.000Z', eventId: 'b', s3Key: 'b' }),
  ], state);

  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'b');
});

test('watch emits timeline events oldest first', () => {
  const state = createWatchState(watchOptions({ sinceMs: 60000 }), new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:03.000Z', eventId: 'c', s3Key: 'c' }),
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'a', s3Key: 'a' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'b', s3Key: 'b' }),
  ], null, state, watchOptions({ sinceMs: 60000 }));

  assert.deepEqual(entries.map(entry => entry.event.eventId), ['a', 'b', 'c']);
});

test('--since prints first-poll serial rows oldest-first', () => {
  const options = watchOptions({ sinceMs: 60000 });
  const state = createWatchState(options, new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: '2', s3Key: '2', eventName: 'serialLog', serialLogLine: 'second' }),
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: '1', s3Key: '1', eventName: 'serialLog', serialLogLine: 'first' }),
  ], null, state, options);

  assert.deepEqual(entries.map(entry => entry.summary), ['first', 'second']);
});

test('cursor prevents duplicates after initial history', () => {
  const options = watchOptions({ sinceMs: 60000 });
  const state = createWatchState(options, new Date('2026-07-14T08:00:10.000Z'));
  buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: '1', s3Key: '1', eventName: 'serialLog', serialLogLine: 'first' }),
  ], null, state, options);
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: '1', s3Key: '1', eventName: 'serialLog', serialLogLine: 'first' }),
  ], null, state, options);

  assert.deepEqual(entries, []);
});

test('watch formats serialLog lines and truncates by default', () => {
  const line = 'x'.repeat(220);
  const entry = watchEntryFromEvent(event({
    eventName: 'serialLog',
    eventType: 'serial.log',
    plane: 'serial',
    serialLogLine: line,
  }), watchOptions());

  assert.equal(entry.category, 'SERIAL');
  assert.equal(entry.summary.length, 160);
  assert.match(entry.summary, /\.\.\.$/);
});

test('watch raw mode preserves full serial content', () => {
  const line = 'x'.repeat(220);
  const entry = watchEntryFromEvent(event({ eventName: 'serialLog', serialLogLine: line }), watchOptions({ raw: true }));

  assert.equal(entry.summary, line);
});

test('watch preserves rapid serial burst order', () => {
  const state = createWatchState(watchOptions({ sinceMs: 60000 }), new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:00.003Z', eventId: '3', s3Key: '3', eventName: 'serialLog', serialLogLine: 'third' }),
    event({ eventTime: '2026-07-14T08:00:00.001Z', eventId: '1', s3Key: '1', eventName: 'serialLog', serialLogLine: 'first' }),
    event({ eventTime: '2026-07-14T08:00:00.002Z', eventId: '2', s3Key: '2', eventName: 'serialLog', serialLogLine: 'second' }),
  ], null, state, watchOptions({ sinceMs: 60000 }));

  assert.deepEqual(entries.map(entry => entry.summary), ['first', 'second', 'third']);
});

test('serial filters serial events and renders oldest-first continuous log lines', () => {
  const options = serialOptions({ timeZone: 'UTC' });
  const state = createSerialState(options, new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildSerialEntries([
    event({ eventTime: '2026-07-14T08:00:03.000Z', eventId: '3', s3Key: '3', eventName: 'notSerial', eventType: 'telemetry.occupancy', plane: 'telemetry', serialLogLine: 'ignore' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: '2', s3Key: '2', eventName: 'custom', eventType: 'serial.log', plane: 'telemetry', serialLogLine: 'by type' }),
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: '1', s3Key: '1', eventName: 'serialLog', serialLogLine: 'by name' }),
    event({ eventTime: '2026-07-14T08:00:04.000Z', eventId: '4', s3Key: '4', eventName: 'custom', eventType: 'custom', plane: 'serial', serialLogLine: 'by plane' }),
  ], state, options);

  assert.deepEqual(entries.map(entry => entry.summary), ['by name', 'by type']);
  assert.deepEqual(entries.map(entry => formatSerialEntry(entry, options)), [
    '08:00:01.000  by name',
    '08:00:02.000  by type',
  ]);
});

test('serial excludes collector lifecycle by default and --include-collector includes both kinds', () => {
  const events = [
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'log', eventName: 'serialLog', eventType: 'serial.log', serialLogLine: 'firmware line' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'disconnect', eventName: 'serialLog', eventType: 'serial.lifecycle.disconnected', serialLogLine: "SerialException('device returned no data')" }),
  ];
  const defaultOptions = serialOptions({ timeZone: 'UTC' });
  const defaultEntries = buildSerialEntries(events, createSerialState(defaultOptions, new Date('2026-07-14T08:00:10.000Z')), defaultOptions);
  assert.deepEqual(defaultEntries.map(entry => entry.kind), ['SERIAL']);

  const combinedOptions = serialOptions({ timeZone: 'UTC', includeCollector: true });
  const combinedEntries = buildSerialEntries(events, createSerialState(combinedOptions, new Date('2026-07-14T08:00:10.000Z')), combinedOptions);
  assert.deepEqual(combinedEntries.map(entry => entry.kind), ['SERIAL', 'COLLECTOR']);
  assert.deepEqual(combinedEntries.map(entry => formatSerialEntry(entry, combinedOptions)), [
    '08:00:01.000  SERIAL     firmware line',
    "08:00:02.000  COLLECTOR  Serial device disconnected: SerialException('device returned no data')",
  ]);
});

test('serial renderer prints timezone once and date dividers across calendar boundaries', () => {
  const renderer = createSerialRenderer(serialOptions({ timeZone: 'UTC' }));
  const lines = [
    ...renderer.format({ time: '2026-07-14T23:59:59.999Z', summary: 'before midnight', event: event({ eventTime: '2026-07-14T23:59:59.999Z', eventId: 'before' }) }),
    ...renderer.format({ time: '2026-07-15T00:00:00.001Z', summary: 'after midnight', event: event({ eventTime: '2026-07-15T00:00:00.001Z', eventId: 'after' }) }),
  ];

  assert.deepEqual(lines, [
    'Timezone: UTC',
    '--- 2026-07-14 ---',
    '23:59:59.999  before midnight',
    '--- 2026-07-15 ---',
    '00:00:00.001  after midnight',
  ]);
});

test('serial suppresses duplicates and preserves identical timestamp event IDs', () => {
  const options = serialOptions();
  const state = createSerialState(options, new Date('2026-07-14T08:00:10.000Z'));
  buildSerialEntries([
    event({ eventTime: '2026-07-14T08:00:00.000Z', eventId: 'a', s3Key: 'a', eventName: 'serialLog', serialLogLine: 'first' }),
  ], state, options);
  const entries = buildSerialEntries([
    event({ eventTime: '2026-07-14T08:00:00.000Z', eventId: 'a', s3Key: 'a', eventName: 'serialLog', serialLogLine: 'first again' }),
    event({ eventTime: '2026-07-14T08:00:00.000Z', eventId: 'b', s3Key: 'b', eventName: 'serialLog', serialLogLine: 'second same timestamp' }),
  ], state, options);

  assert.deepEqual(entries.map(entry => entry.summary), ['second same timestamp']);
});

test('serial window calculation and --until use the requested reconstruction range', async () => {
  const options = serialOptions({ until: '2026-07-14T08:00:00.000Z' });
  const calls = [];

  await runSerialLoop({}, { deviceId: 'device123' }, options, {
    now: () => new Date('2026-07-14T09:00:00.000Z'),
    fetchTimeline: async (_context, deviceId, state, now) => {
      calls.push({ deviceId, start: state.timelineStart, end: now.toISOString() });
      return { events: [] };
    },
  });

  assert.deepEqual(calls, [{
    deviceId: 'device123',
    start: '2026-07-14T07:00:00.000Z',
    end: '2026-07-14T08:00:00.000Z',
  }]);
});

test('serial grep, limit, raw, JSON mode, and no serial rows', () => {
  const grepOptions = serialOptions({ grep: 'keep', limit: 1 });
  const state = createSerialState(grepOptions, new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildSerialEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'drop', s3Key: 'drop', eventName: 'serialLog', serialLogLine: 'drop this line' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'keep', s3Key: 'keep', eventName: 'serialLog', serialLogLine: 'keep this line' }),
    event({ eventTime: '2026-07-14T08:00:03.000Z', eventId: 'also', s3Key: 'also', eventName: 'serialLog', serialLogLine: 'keep this too' }),
  ], state, grepOptions);

  assert.deepEqual(entries.map(entry => entry.summary), ['keep this line']);
  assert.deepEqual(buildSerialEntries([event({ eventName: 'notSerial', eventType: 'telemetry.occupancy', plane: 'telemetry' })], createSerialState(serialOptions(), new Date('2026-07-14T08:00:10.000Z')), serialOptions()), []);

  const json = JSON.parse(formatSerialEntry(entries[0], serialOptions({ json: true })));
  assert.equal(json.time, '2026-07-14T08:00:02.000Z');
  assert.equal(json.line, 'keep this line');
  assert.equal(json.source, 'cloud-forwarded serial');
  assert.equal(json.event.eventId, 'keep');

  assert.equal(formatSerialEntry(entries[0], serialOptions({ verbose: true })), '2026-07-14T08:00:02.000Z  keep this line');
});

test('serial --follow starts from now without printing initial lookback', async () => {
  const options = serialOptions({ sinceMs: 0, follow: true });
  const output = [];
  const controller = new AbortController();
  let calls = 0;

  await runSerialLoop({}, { deviceId: 'device123' }, options, {
    signal: controller.signal,
    now: () => new Date('2026-07-14T08:00:10.000Z'),
    fetchTimeline: async () => {
      calls += 1;
      if (calls === 1) return { events: [event({ eventTime: '2026-07-14T08:00:09.000Z', eventId: 'old', s3Key: 'old', eventName: 'serialLog', serialLogLine: 'old' })] };
      return { events: [event({ eventTime: '2026-07-14T08:00:11.000Z', eventId: 'new', s3Key: 'new', eventName: 'serialLog', serialLogLine: 'new' })] };
    },
    write: line => output.push(line),
    sleep: async () => {
      if (calls >= 2) controller.abort();
    },
  });

  assert.deepEqual(output, [
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `--- ${new Date('2026-07-14T08:00:11.000Z').toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })} ---`,
    `${new Date('2026-07-14T08:00:11.000Z').toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}  new`,
  ]);
});

test('serial pagination and transient retry reuse watch timeline behavior', async () => {
  const output = [];
  const warnings = [];
  const controller = new AbortController();
  let attempts = 0;
  let sleeps = 0;

  await runSerialLoop({}, { deviceId: 'device123' }, serialOptions({ follow: true }), {
    signal: controller.signal,
    now: () => new Date('2026-07-14T08:00:10.000Z'),
    fetchTimeline: async () => {
      attempts += 1;
      if (attempts === 1) throw new TransientWatchError('temporary outage');
      return { events: [event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'serial', s3Key: 'serial', eventName: 'serialLog', serialLogLine: 'after retry' })] };
    },
    write: line => output.push(line),
    warn: message => warnings.push(message),
    sleep: async () => {
      sleeps += 1;
      if (sleeps >= 2) controller.abort();
    },
  });

  assert.equal(attempts, 2);
  assert.match(output.join('\n'), /after retry/);
  assert.deepEqual(warnings, []);
});

test('serial timeline fetch paginates API history pages', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    const pageIndex = urls.length;
    return {
      ok: true,
      text: async () => JSON.stringify({
        events: pageIndex === 1
          ? [event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'newer', s3Key: 'newer', eventName: 'serialLog', serialLogLine: 'newer' })]
          : pageIndex === 2
            ? [event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'older', s3Key: 'older', eventName: 'serialLog', serialLogLine: 'older' })]
            : [],
      }),
    };
  };

  try {
    const options = serialOptions({ limit: 1 });
    const state = createSerialState(options, new Date('2026-07-14T08:00:03.000Z'));
    const timeline = await fetchSerialTimeline({ webhookSecret: 'secret', queryApiBaseUrl: 'https://query.example.test' }, 'device123', state, new Date('2026-07-14T08:00:03.000Z'), options);

    assert.equal(urls.length, 3);
    assert.deepEqual(timeline.events.map(item => item.eventId), ['newer', 'older']);
    assert.match(urls[1], /end=2026-07-14T08%3A00%3A02\.000Z/);
    assert.match(urls[2], /end=2026-07-14T08%3A00%3A01\.000Z/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Particle status events classify as lifecycle', () => {
  assert.equal(classifyTimelineEvent(event({ eventName: 'status', eventType: 'particle.status', occupancy: undefined, battery: undefined })).category, 'LIFECYCLE');
});

test('timeline mixed output uses TIME, KIND, and SUMMARY presentation columns', () => {
  const result = timelinePresentationRows({ deviceId: 'device123', deviceName: 'Boron' }, {
    events: [
      event({ eventType: 'telemetry.occupancy' }),
      event({ eventName: 'serialLog', eventType: 'serial.lifecycle.connected', serialLogLine: '/dev/serial/by-id/boron' }),
    ],
  });
  assert.deepEqual(result.columns, ['TIME', 'KIND', 'SUMMARY']);
  assert.deepEqual(result.rows.map(row => [row.KIND, row.SUMMARY]), [
    ['TELEMETRY', 'occupancy=14 battery=87'],
    ['COLLECTOR', 'Serial device connected: /dev/serial/by-id/boron'],
  ]);
});

test('timeline serial-only output renders actual log lines', () => {
  const result = timelinePresentationRows({ deviceId: 'device123', deviceName: 'Boron' }, {
    events: [event({ eventName: 'serialLog', eventType: 'serial.log', serialLogLine: 'boot complete' })],
  });
  assert.deepEqual(result.columns, ['TIME', 'SERIAL LOG']);
  assert.equal(result.rows[0]['SERIAL LOG'], 'boot complete');
});

test('watch uses shared collector classification', () => {
  const entry = watchEntryFromEvent(event({
    eventName: 'serialLog',
    eventType: 'serial.lifecycle.missing',
    plane: 'serial',
  }), watchOptions());
  assert.equal(entry.kind, 'COLLECTOR');
  assert.equal(entry.category, 'COLLECTOR');
  assert.equal(entry.summary, 'Serial device missing');
});

test('watch detects current-state snapshot timestamp changes', () => {
  const entries = detectCurrentStateChanges(
    { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:30.104Z', deviceDataLedgerUpdatedAt: '2026-07-14T08:00:30.105Z' },
    { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:00.000Z', deviceDataLedgerUpdatedAt: undefined }
  );

  assert.deepEqual(entries.map(entry => [entry.category, entry.summary]), [
    ['RUNTIME', 'device-status snapshot updated'],
    ['DATA', 'device-data snapshot updated'],
  ]);
});

test('initial RUNTIME snapshot is emitted once', () => {
  const state = createWatchState(watchOptions(), new Date('2026-07-14T08:00:10.000Z'));
  const first = buildWatchEntries([], { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:30.104Z' }, state, watchOptions());
  const second = buildWatchEntries([], { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:30.104Z' }, state, watchOptions());

  assert.deepEqual(first.map(entry => [entry.category, entry.summary]), [['RUNTIME', 'device-status snapshot available']]);
  assert.deepEqual(second, []);
});

test('initial DATA snapshot is emitted once', () => {
  const state = createWatchState(watchOptions(), new Date('2026-07-14T08:00:10.000Z'));
  const first = buildWatchEntries([], { deviceDataLedgerUpdatedAt: '2026-07-14T08:00:30.105Z' }, state, watchOptions());
  const second = buildWatchEntries([], { deviceDataLedgerUpdatedAt: '2026-07-14T08:00:30.105Z' }, state, watchOptions());

  assert.deepEqual(first.map(entry => [entry.category, entry.summary]), [['DATA', 'device-data snapshot available']]);
  assert.deepEqual(second, []);
});

test('device-status Ledger changes classify as runtime', () => {
  const [entry] = detectCurrentStateChanges(
    { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:30.104Z' },
    { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:00.000Z' }
  );

  assert.equal(entry.category, 'RUNTIME');
});

test('device-data Ledger changes classify as data', () => {
  const [entry] = detectCurrentStateChanges(
    { deviceDataLedgerUpdatedAt: '2026-07-14T08:00:30.105Z' },
    { deviceDataLedgerUpdatedAt: undefined }
  );

  assert.equal(entry.category, 'DATA');
});

test('watch suppresses unchanged current-state snapshots', () => {
  const entries = detectCurrentStateChanges(
    { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:30.104Z' },
    { deviceStatusLedgerUpdatedAt: '2026-07-14T08:00:30.104Z' }
  );

  assert.deepEqual(entries, []);
});

test('watch JSON mode emits structured line JSON', () => {
  const output = formatWatchEntry({
    time: '2026-07-14T08:00:00.000Z',
    category: 'SERIAL',
    summary: 'boot',
    event: event({ eventName: 'serialLog', serialLogLine: 'boot' }),
  }, watchOptions({ json: true }));

  const payload = JSON.parse(output);
  assert.deepEqual({
    time: payload.time,
    category: payload.category,
    summary: payload.summary,
    event: payload.event,
  }, {
    time: '2026-07-14T08:00:00.000Z',
    category: 'SERIAL',
    summary: 'boot',
    event: event({ eventName: 'serialLog', serialLogLine: 'boot' }),
  });
  assert.equal(payload.kind, 'SERIAL');
  assert.equal(payload.severity, null);
});

test('watch renders Timeline and synthesized snapshot timestamps in the same selected timezone', () => {
  const options = watchOptions({ timeZone: 'UTC' });
  const serial = formatWatchEntry({
    time: '2026-07-14T14:10:15.685Z',
    kind: 'SERIAL',
    category: 'SERIAL',
    summary: 'firmware line',
  }, options);
  const runtime = formatWatchEntry({
    time: '2026-07-14T18:06:09.307Z',
    kind: 'RUNTIME',
    category: 'RUNTIME',
    summary: 'device-status snapshot updated',
  }, options);

  assert.match(serial, /^14:10:15\.685\s+SERIAL/);
  assert.match(runtime, /^18:06:09\.307\s+RUNTIME/);
});

test('watch type filters include and exclude categories', () => {
  const state = createWatchState(watchOptions({ sinceMs: 60000 }), new Date('2026-07-14T08:00:10.000Z'));
  const entries = buildWatchEntries([
    event({ eventTime: '2026-07-14T08:00:01.000Z', eventId: 'serial', s3Key: 'serial', eventName: 'serialLog', serialLogLine: 'boot' }),
    event({ eventTime: '2026-07-14T08:00:02.000Z', eventId: 'telemetry', s3Key: 'telemetry', occupancy: 12 }),
  ], null, state, watchOptions({ sinceMs: 60000, includeTypes: new Set(['SERIAL', 'TELEMETRY']), excludeTypes: new Set(['TELEMETRY']) }));

  assert.deepEqual(entries.map(entry => entry.category), ['SERIAL']);
});

test('watch retries transient API failures and recovers without losing cursor', async () => {
  const output = [];
  const warnings = [];
  const controller = new AbortController();
  let attempts = 0;
  let sleeps = 0;

  await runWatchLoop({}, { deviceId: 'device123' }, watchOptions({ sinceMs: 60000 }), {
    signal: controller.signal,
    now: () => new Date('2026-07-14T08:00:10.000Z'),
    fetchTimeline: async () => {
      attempts += 1;
      if (attempts === 1) throw new TransientWatchError('temporary outage');
      return { events: [event({ eventTime: '2026-07-14T08:00:11.000Z', eventId: 'new', s3Key: 'new' })] };
    },
    loadCurrentState: async () => null,
    write: line => output.push(line),
    warn: message => warnings.push(message),
    sleep: async () => {
      sleeps += 1;
      if (sleeps >= 2) controller.abort();
    },
  });

  assert.equal(attempts, 2);
  assert.equal(output.length, 1);
  assert.equal(warnings.length, 0);
});

test('watch exits cleanly when aborted during sleep', async () => {
  const controller = new AbortController();
  let sleeps = 0;

  await runWatchLoop({}, { deviceId: 'device123' }, watchOptions(), {
    signal: controller.signal,
    now: () => new Date('2026-07-14T08:00:10.000Z'),
    fetchTimeline: async () => ({ events: [] }),
    loadCurrentState: async () => null,
    sleep: async () => {
      sleeps += 1;
      controller.abort();
    },
  });

  assert.equal(sleeps, 1);
});

test('startup banner explains --since for default from-now mode', () => {
  const lines = getWatchBannerLines({ deviceId: 'device123', deviceName: 'P2-NewCode-Dev' }, watchOptions());

  assert.deepEqual(lines.slice(0, 4), [
    'Watching P2-NewCode-Dev (device123) from now',
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    'Use --since <duration> to include recent history.',
    'Press Ctrl-C to stop.',
  ]);
  assert.equal(formatDuration(300000), '5m');
});

test('Dynamo fallback paginates across multiple pages', () => {
  const calls = [];
  const context = {
    options: {},
    logEventsTableName: 'events-table',
    awsJson: (_options, args, settings) => {
      calls.push({ args, settings });
      if (calls.length === 1) {
        return {
          Items: [dynamoItem({ eventId: 'newer', s3Key: 'newer', eventTime: '2026-07-14T08:00:02.000Z' })],
          LastEvaluatedKey: { deviceId: { S: 'device123' }, eventTime: { S: '2026-07-14T08:00:02.000Z' } },
        };
      }
      return { Items: [dynamoItem({ eventId: 'older', s3Key: 'older', eventTime: '2026-07-14T08:00:01.000Z' })] };
    },
  };

  const timeline = queryTimelineFromDynamo(context, 'device123', {
    start: '2026-07-14T08:00:00.000Z',
    end: '2026-07-14T08:00:03.000Z',
    limit: 2,
    pageLimit: 1,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(timeline.events.map(item => item.eventId), ['newer', 'older']);
  assert.equal(calls[0].settings.operation, 'dynamodb query timeline');
  assert.equal(calls[0].settings.tableName, 'events-table');
  assert.equal(calls[0].settings.deviceId, 'device123');
});

test('Dynamo fallback uses bounded page sizes for large result sets', () => {
  const limits = [];
  const context = {
    options: {},
    logEventsTableName: 'events-table',
    awsJson: (_options, args) => {
      limits.push(Number(args[args.indexOf('--limit') + 1]));
      return {
        Items: Array.from({ length: limits[limits.length - 1] }, (_, index) => dynamoItem({ eventId: `event-${limits.length}-${index}`, s3Key: `s3/${limits.length}/${index}` })),
        ...(limits.length < 3 && { LastEvaluatedKey: { deviceId: { S: 'device123' }, eventTime: { S: String(limits.length) } } }),
      };
    },
  };

  const timeline = queryTimelineFromDynamo(context, 'device123', {
    start: '2026-07-14T08:00:00.000Z',
    end: '2026-07-14T08:00:03.000Z',
    limit: 450,
  });

  assert.deepEqual(limits, [200, 200, 50]);
  assert.equal(timeline.events.length, 450);
});

test('Dynamo fallback treats empty quiet polls as valid when allowed', () => {
  const timeline = queryTimelineFromDynamo({
    options: {},
    logEventsTableName: 'events-table',
    awsJson: () => ({ Items: [] }),
  }, 'device123', {
    start: '2026-07-14T08:00:00.000Z',
    end: '2026-07-14T08:00:03.000Z',
    limit: 10,
    allowEmpty: true,
  });

  assert.equal(timeline.count, 0);
  assert.deepEqual(timeline.events, []);
});
