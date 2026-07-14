'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const {
  TransientWatchError,
  buildWatchEntries,
  classifyTimelineEvent,
  collectNewTimelineEvents,
  createWatchState,
  detectCurrentStateChanges,
  enrichDeviceNames,
  formatWatchEntry,
  isDeviceId,
  parseOptions,
  resolveDeviceSelector,
  runWatchLoop,
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

function event(overrides = {}) {
  return {
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

test('command help exits successfully without external configuration', () => {
  const result = runTelemetry(['timeline', '--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Timeline lookback window/);
  assert.doesNotMatch(result.stderr, /AWS|region|credentials/i);
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

test('Particle status events classify as lifecycle', () => {
  assert.equal(classifyTimelineEvent(event({ eventName: 'status', eventType: 'particle.status', occupancy: undefined, battery: undefined })).category, 'LIFECYCLE');
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

  assert.deepEqual(JSON.parse(output), {
    time: '2026-07-14T08:00:00.000Z',
    category: 'SERIAL',
    summary: 'boot',
    event: event({ eventName: 'serialLog', serialLogLine: 'boot' }),
  });
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
