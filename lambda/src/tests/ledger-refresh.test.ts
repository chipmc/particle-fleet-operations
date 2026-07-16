import { clearDeviceProductIdCacheForTests, refreshDeviceStatusLedger } from '../ledger-refresh';
import { resolveParticleDeviceProductId } from '../integrations/particle-api';
import { ParticleLedgerClient, ParticleLedgerNames, ParticleLedgerResult } from '../integrations/particle-ledger';
import {
  projectMissingDeviceSettingsLedger,
  updateDeviceSettingsLedgerSnapshot,
  updateDeviceStatusLedgerSnapshot,
  updateProductDefaultsLedgerSnapshot,
} from '../storage/current-state';
import { DeviceCurrentState, ParticleWebhook } from '../types';

jest.mock('../integrations/particle-api');
jest.mock('../storage/current-state');

const mockResolveProductId = resolveParticleDeviceProductId as jest.MockedFunction<typeof resolveParticleDeviceProductId>;
const mockUpdateSnapshot = updateDeviceStatusLedgerSnapshot as jest.MockedFunction<typeof updateDeviceStatusLedgerSnapshot>;
const mockUpdateProductDefaults = updateProductDefaultsLedgerSnapshot as jest.MockedFunction<typeof updateProductDefaultsLedgerSnapshot>;
const mockUpdateDeviceSettings = updateDeviceSettingsLedgerSnapshot as jest.MockedFunction<typeof updateDeviceSettingsLedgerSnapshot>;
const mockProjectMissingDeviceSettings = projectMissingDeviceSettingsLedger as jest.MockedFunction<typeof projectMissingDeviceSettingsLedger>;
const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);

const originalEnv = process.env;
const eligibleEventName = 'Ubidots-Sensor-Hook-v1';
const deviceId = 'device123';
const secondDeviceId = 'device456';
const productId = '12345';
const startTime = new Date('2026-07-13T10:10:00.000Z');
const insideCooldown = new Date('2026-07-13T10:10:30.000Z');
const afterCooldown = new Date('2026-07-13T10:11:01.000Z');

const eligibleBody: ParticleWebhook = {
  event: eligibleEventName,
  coreid: deviceId,
  product_id: productId,
};

function createPrevious(ledgerUpdatedAt?: string): DeviceCurrentState {
  return {
    projectId: 'generalized-core-counter',
    deviceId,
    lastEventTime: '2026-07-13T10:00:00.000Z',
    lastIngestTime: '2026-07-13T10:00:05.000Z',
    lastEventType: 'telemetry.event',
    healthStatus: 'unknown',
    anomalyCount: 0,
    offlineCandidate: false,
    ...(ledgerUpdatedAt && { deviceStatusLedgerUpdatedAt: ledgerUpdatedAt }),
    updatedAt: '2026-07-13T10:00:05.000Z',
  };
}

function createClient(result: ParticleLedgerResult | Promise<ParticleLedgerResult>): ParticleLedgerClient {
  return {
    getDeviceStatus: jest.fn().mockResolvedValue(result),
    getProductDefaults: jest.fn().mockResolvedValue(configurationSuccess(
      ParticleLedgerNames.productDefault,
      productId,
      { timing: { reportingIntervalSec: 3600, connectAttemptBudgetSec: 300 } },
      '2026-07-13T09:00:00.000Z'
    )),
    getDeviceSettings: jest.fn().mockResolvedValue(failureResult('missing_ledger')),
  } as unknown as ParticleLedgerClient;
}

function createClientWithImplementation(
  implementation: (productId: string, deviceId: string) => Promise<ParticleLedgerResult>
): ParticleLedgerClient {
  return {
    getDeviceStatus: jest.fn(implementation),
    getProductDefaults: jest.fn().mockResolvedValue(configurationSuccess(
      ParticleLedgerNames.productDefault,
      productId,
      { timing: { reportingIntervalSec: 3600, connectAttemptBudgetSec: 300 } },
      '2026-07-13T09:00:00.000Z'
    )),
    getDeviceSettings: jest.fn().mockResolvedValue(failureResult('missing_ledger')),
  } as unknown as ParticleLedgerClient;
}

function configurationSuccess(
  ledgerName: typeof ParticleLedgerNames.productDefault | typeof ParticleLedgerNames.deviceSettings,
  scopeValue: string,
  data: Record<string, unknown>,
  updatedAt: string
): ParticleLedgerResult {
  return {
    ok: true,
    ledgerName,
    productId,
    scopeValue,
    data,
    instance: {
      name: ledgerName,
      data,
      updated_at: updatedAt,
      size_bytes: 128,
    },
  };
}

function successResult(updatedAt: string, resultProductId: string = productId, resultDeviceId: string = deviceId): ParticleLedgerResult {
  return {
    ok: true,
    ledgerName: ParticleLedgerNames.deviceStatus,
    productId: resultProductId,
    scopeValue: resultDeviceId,
    data: { connection: { state: 'connected' } },
    instance: {
      name: ParticleLedgerNames.deviceStatus,
      scope: { type: 'Device', value: resultDeviceId },
      size_bytes: 256,
      data: { connection: { state: 'connected' } },
      updated_at: updatedAt,
    },
  };
}

function failureResult(kind: 'missing_ledger' | 'retryable_failure' | 'network_failure', httpStatus?: number): ParticleLedgerResult {
  return {
    ok: false,
    ledgerName: ParticleLedgerNames.deviceStatus,
    productId,
    scopeValue: deviceId,
    error: {
      kind,
      message: 'failed',
      retryable: kind !== 'missing_ledger',
      ...(httpStatus !== undefined && { httpStatus }),
    },
  };
}

async function refresh(overrides: Partial<Parameters<typeof refreshDeviceStatusLedger>[0]> = {}) {
  return refreshDeviceStatusLedger({
    tableName: 'current-state-table',
    projectId: 'generalized-core-counter',
    deviceId,
    body: eligibleBody,
    previous: null,
    fetchedAt: startTime,
    ...overrides,
  });
}

function expectNoParticleWork(client: ParticleLedgerClient): void {
  expect(mockResolveProductId).not.toHaveBeenCalled();
  expect(client.getDeviceStatus).not.toHaveBeenCalled();
  expect(mockUpdateSnapshot).not.toHaveBeenCalled();
}

function expectSkipLog(expected: Record<string, unknown>): void {
  expect(infoSpy).toHaveBeenCalledTimes(1);
  expect(infoSpy).toHaveBeenCalledWith('Ledger refresh skipped', JSON.stringify(expected));
}

describe('device-status Ledger refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      PARTICLE_LEDGER_REFRESH_ENABLED: 'true',
      PARTICLE_LEDGER_REFRESH_DEVICE_IDS: deviceId,
      PARTICLE_LEDGER_REFRESH_PRODUCT_IDS: '',
      PARTICLE_LEDGER_REFRESH_EVENT_NAMES: eligibleEventName,
      PARTICLE_LEDGER_REFRESH_MIN_INTERVAL_SECONDS: '60',
    };
    clearDeviceProductIdCacheForTests();
    mockUpdateSnapshot.mockResolvedValue('updated');
    mockUpdateProductDefaults.mockResolvedValue('updated');
    mockUpdateDeviceSettings.mockResolvedValue('updated');
    mockProjectMissingDeviceSettings.mockResolvedValue('updated');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(() => {
    infoSpy.mockRestore();
  });

  it('should treat serialLog as not eligible and make no Particle API calls', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ body: { event: 'serialLog', coreid: deviceId }, ledgerClient: client })).resolves.toBe('event_not_eligible');

    expectNoParticleWork(client);
    expectSkipLog({ reason: 'event_not_allowlisted', eventName: 'serialLog' });
  });

  it('should refresh for an eligible Ubidots-Sensor-Hook-v1 event', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(client.getDeviceStatus).toHaveBeenCalledWith(productId, deviceId);
  });

  it('should project product defaults and device settings into DeviceCurrentState', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));
    const deviceSettings = { timing: { reportingIntervalSec: 1800 } };
    (client.getDeviceSettings as jest.Mock).mockResolvedValue(configurationSuccess(
      ParticleLedgerNames.deviceSettings,
      deviceId,
      deviceSettings,
      '2026-07-13T09:30:00.000Z'
    ));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(client.getProductDefaults).toHaveBeenCalledWith(productId);
    expect(client.getDeviceSettings).toHaveBeenCalledWith(productId, deviceId);
    expect(mockUpdateProductDefaults).toHaveBeenCalledWith(
      'current-state-table',
      'generalized-core-counter',
      deviceId,
      expect.objectContaining({
        updatedAt: '2026-07-13T09:00:00.000Z',
        data: { timing: { reportingIntervalSec: 3600, connectAttemptBudgetSec: 300 } },
      })
    );
    expect(mockUpdateDeviceSettings).toHaveBeenCalledWith(
      'current-state-table',
      'generalized-core-counter',
      deviceId,
      expect.objectContaining({
        updatedAt: '2026-07-13T09:30:00.000Z',
        data: deviceSettings,
      })
    );
    expect(mockProjectMissingDeviceSettings).not.toHaveBeenCalled();
  });

  it('should record an optional missing device-settings Ledger without removing product defaults', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(mockUpdateProductDefaults).toHaveBeenCalledTimes(1);
    expect(mockUpdateDeviceSettings).not.toHaveBeenCalled();
    expect(mockProjectMissingDeviceSettings).toHaveBeenCalledWith(
      'current-state-table',
      'generalized-core-counter',
      deviceId,
      startTime.toISOString()
    );
  });

  it('should refresh when the device is explicitly allow-listed and no product list is configured', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = deviceId;
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = '';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(mockResolveProductId).not.toHaveBeenCalled();
    expect(client.getDeviceStatus).toHaveBeenCalledWith(productId, deviceId);
  });

  it('should short-circuit before event-name handling and API calls when disabled', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_ENABLED = 'false';
    process.env.PARTICLE_LEDGER_REFRESH_EVENT_NAMES = '';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('disabled');

    expectNoParticleWork(client);
    expectSkipLog({ reason: 'disabled' });
  });

  it('should make no API calls for a non-allow-listed device', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = 'other-device';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('not_allow_listed');

    expectNoParticleWork(client);
    expectSkipLog({ reason: 'device_not_allowlisted', deviceId });
  });

  it('should refresh when the webhook product ID is allow-listed', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = '';
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = productId;
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(mockResolveProductId).not.toHaveBeenCalled();
    expect(client.getDeviceStatus).toHaveBeenCalledWith(productId, deviceId);
  });

  it('should make no API calls when neither device nor product is allow-listed', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = 'other-device';
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = '67890';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('not_allow_listed');

    expect(mockResolveProductId).not.toHaveBeenCalled();
    expect(client.getDeviceStatus).not.toHaveBeenCalled();
    expect(mockUpdateSnapshot).not.toHaveBeenCalled();
    expectSkipLog({ reason: 'device_not_allowlisted', deviceId });
  });

  it('should use the cached product-ID resolver when webhook product ID is missing for product eligibility', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = '';
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = '67890';
    mockResolveProductId.mockResolvedValue({
      productId: '67890',
      productIdResolvedAt: '2026-07-13T10:10:00.000Z',
      productIdSource: 'particle-api',
    });
    const client = createClient({ ...successResult('2026-07-13T10:05:00.000Z'), productId: '67890' });
    const bodyWithoutProductId = { event: eligibleEventName, coreid: deviceId };

    await refresh({ body: bodyWithoutProductId, ledgerClient: client, fetchedAt: startTime });
    await refresh({ body: bodyWithoutProductId, ledgerClient: client, fetchedAt: afterCooldown });

    expect(mockResolveProductId).toHaveBeenCalledTimes(1);
    expect(client.getDeviceStatus).toHaveBeenCalledTimes(2);
    expect(client.getDeviceStatus).toHaveBeenNthCalledWith(1, '67890', deviceId);
    expect(client.getDeviceStatus).toHaveBeenNthCalledWith(2, '67890', deviceId);
  });

  it('should perform no product lookup for serialLog even when product eligibility is configured', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = '';
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = productId;
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ body: { event: 'serialLog', coreid: deviceId }, ledgerClient: client })).resolves.toBe('event_not_eligible');

    expectNoParticleWork(client);
    expectSkipLog({ reason: 'event_not_allowlisted', eventName: 'serialLog' });
  });

  it('should parse comma-separated product IDs with surrounding whitespace', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = '';
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = ' 11111 , 12345 , 67890 ';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(client.getDeviceStatus).toHaveBeenCalledWith(productId, deviceId);
  });

  it('should treat an empty product list as not product allow-listed', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = '';
    process.env.PARTICLE_LEDGER_REFRESH_PRODUCT_IDS = ' , , ';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('not_allow_listed');

    expectNoParticleWork(client);
    expectSkipLog({ reason: 'device_not_allowlisted', deviceId });
  });

  it('should make no event eligible when event-name configuration is empty', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_EVENT_NAMES = '';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('event_not_eligible');

    expectNoParticleWork(client);
    expectSkipLog({ reason: 'event_not_allowlisted', eventName: eligibleEventName });
  });

  it('should parse multiple event names with surrounding whitespace', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_EVENT_NAMES = ' serialLog , Ubidots-Sensor-Hook-v1 , diagnostics ';
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(client.getDeviceStatus).toHaveBeenCalledWith(productId, deviceId);
  });

  it('should perform a Ledger refresh for the first eligible event', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ ledgerClient: client })).resolves.toBe('updated');

    expect(client.getDeviceStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('should perform no Particle calls for a second eligible event inside cooldown', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await refresh({ ledgerClient: client, fetchedAt: startTime });
    jest.clearAllMocks();

    await expect(refresh({ ledgerClient: client, fetchedAt: insideCooldown })).resolves.toBe('refresh_cooldown');

    expectNoParticleWork(client);
  });

  it('should refresh again for an eligible event after cooldown', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await refresh({ ledgerClient: client, fetchedAt: startTime });
    await refresh({ ledgerClient: client, fetchedAt: afterCooldown });

    expect(client.getDeviceStatus).toHaveBeenCalledTimes(2);
  });

  it('should isolate cooldown per device', async () => {
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = `${deviceId},${secondDeviceId}`;
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await refresh({ ledgerClient: client, fetchedAt: startTime });
    await refresh({
      deviceId: secondDeviceId,
      body: { event: eligibleEventName, coreid: secondDeviceId, product_id: productId },
      ledgerClient: client,
      fetchedAt: insideCooldown,
    });

    expect(client.getDeviceStatus).toHaveBeenCalledTimes(2);
    expect(client.getDeviceStatus).toHaveBeenNthCalledWith(2, productId, secondDeviceId);
  });

  it('should deduplicate overlapping same-device eligible calls', async () => {
    let resolveLedger: (result: ParticleLedgerResult) => void = () => undefined;
    const ledgerPromise = new Promise<ParticleLedgerResult>((resolve) => {
      resolveLedger = resolve;
    });
    const client = createClientWithImplementation(() => ledgerPromise);

    const firstRefresh = refresh({ ledgerClient: client, fetchedAt: startTime });
    const secondRefresh = refresh({ ledgerClient: client, fetchedAt: startTime });

    await Promise.resolve();
    expect(client.getDeviceStatus).toHaveBeenCalledTimes(1);
    resolveLedger(successResult('2026-07-13T10:05:00.000Z'));

    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual(['updated', 'updated']);
    expect(mockUpdateSnapshot).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenNthCalledWith(
      1,
      'Ledger refresh skipped',
      JSON.stringify({ reason: 'inflight', deviceId })
    );
  });

  it('should allow retry after cooldown when a refresh fails', async () => {
    const client = createClientWithImplementation(jest.fn()
      .mockResolvedValueOnce(failureResult('retryable_failure', 503))
      .mockResolvedValueOnce(successResult('2026-07-13T10:05:00.000Z')));

    await expect(refresh({ ledgerClient: client, fetchedAt: startTime })).resolves.toBe('not_found_or_failed');
    await expect(refresh({ ledgerClient: client, fetchedAt: afterCooldown })).resolves.toBe('updated');

    expect(client.getDeviceStatus).toHaveBeenCalledTimes(2);
  });

  it('should use webhook-supplied product ID without device lookup', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await refresh({ ledgerClient: client });

    expect(mockResolveProductId).not.toHaveBeenCalled();
    expect(client.getDeviceStatus).toHaveBeenCalledWith(productId, deviceId);
  });

  it('should use fallback product ID lookup once and then the warm-container cache', async () => {
    mockResolveProductId.mockResolvedValue({
      productId: '67890',
      productIdResolvedAt: '2026-07-13T10:10:00.000Z',
      productIdSource: 'particle-api',
    });
    const client = createClient({ ...successResult('2026-07-13T10:05:00.000Z'), productId: '67890' });
    const bodyWithoutProductId = { event: eligibleEventName, coreid: deviceId };

    await refresh({ body: bodyWithoutProductId, ledgerClient: client, fetchedAt: startTime });
    await refresh({ body: bodyWithoutProductId, ledgerClient: client, fetchedAt: afterCooldown });

    expect(mockResolveProductId).toHaveBeenCalledTimes(1);
    expect(client.getDeviceStatus).toHaveBeenCalledTimes(2);
    expect(client.getDeviceStatus).toHaveBeenNthCalledWith(1, '67890', deviceId);
    expect(client.getDeviceStatus).toHaveBeenNthCalledWith(2, '67890', deviceId);
  });

  it('should conditionally write a newer Ledger snapshot', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    await expect(refresh({ previous: createPrevious('2026-07-13T10:00:00.000Z'), ledgerClient: client })).resolves.toBe('updated');

    expect(mockUpdateSnapshot).toHaveBeenCalledWith(
      'current-state-table',
      'generalized-core-counter',
      deviceId,
      {
        updatedAt: '2026-07-13T10:05:00.000Z',
        fetchedAt: '2026-07-13T10:10:00.000Z',
        sizeBytes: 256,
        data: { connection: { state: 'connected' } },
      }
    );
  });

  it('should leave equal and older snapshots unchanged', async () => {
    const equalClient = createClient(successResult('2026-07-13T10:05:00.000Z'));
    await expect(refresh({ previous: createPrevious('2026-07-13T10:05:00.000Z'), ledgerClient: equalClient })).resolves.toBe('stale');

    clearDeviceProductIdCacheForTests();
    const olderClient = createClient(successResult('2026-07-13T10:04:59.000Z'));
    await expect(refresh({ previous: createPrevious('2026-07-13T10:05:00.000Z'), ledgerClient: olderClient })).resolves.toBe('stale');

    expect(mockUpdateSnapshot).not.toHaveBeenCalled();
  });

  it('should classify Ledger 429, timeout, and 5xx as failed refreshes without writes', async () => {
    const failures = [
      failureResult('retryable_failure', 429),
      failureResult('network_failure'),
      failureResult('retryable_failure', 503),
    ];
    const client = createClientWithImplementation(jest.fn()
      .mockResolvedValueOnce(failures[0])
      .mockResolvedValueOnce(failures[1])
      .mockResolvedValueOnce(failures[2]));

    await expect(refresh({ ledgerClient: client, fetchedAt: startTime })).resolves.toBe('not_found_or_failed');
    await expect(refresh({ ledgerClient: client, fetchedAt: afterCooldown })).resolves.toBe('not_found_or_failed');
    await expect(refresh({ ledgerClient: client, fetchedAt: new Date('2026-07-13T10:12:02.000Z') })).resolves.toBe('not_found_or_failed');

    expect(client.getDeviceStatus).toHaveBeenCalledTimes(3);
    expect(mockUpdateSnapshot).not.toHaveBeenCalled();
  });

  it('should emit one INFO log for each skipped path', async () => {
    const client = createClient(successResult('2026-07-13T10:05:00.000Z'));

    process.env.PARTICLE_LEDGER_REFRESH_ENABLED = 'false';
    await refresh({ ledgerClient: client });
    process.env.PARTICLE_LEDGER_REFRESH_ENABLED = 'true';
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = 'other-device';
    await refresh({ ledgerClient: client });
    process.env.PARTICLE_LEDGER_REFRESH_DEVICE_IDS = deviceId;
    await refresh({ body: { event: 'serialLog', coreid: deviceId }, ledgerClient: client });
    await refresh({ ledgerClient: client, fetchedAt: startTime });
    await refresh({ ledgerClient: client, fetchedAt: insideCooldown });

    expect(infoSpy).toHaveBeenCalledTimes(5);
    expect(infoSpy).toHaveBeenNthCalledWith(1, 'Ledger refresh skipped', JSON.stringify({ reason: 'disabled' }));
    expect(infoSpy).toHaveBeenNthCalledWith(2, 'Ledger refresh skipped', JSON.stringify({ reason: 'device_not_allowlisted', deviceId }));
    expect(infoSpy).toHaveBeenNthCalledWith(3, 'Ledger refresh skipped', JSON.stringify({ reason: 'event_not_allowlisted', eventName: 'serialLog' }));
    expect(JSON.parse(infoSpy.mock.calls[3][1] as string)).toMatchObject({ result: 'updated' });
    expect(infoSpy).toHaveBeenNthCalledWith(5, 'Ledger refresh skipped', JSON.stringify({ reason: 'cooldown', deviceId, remainingSeconds: 30 }));
  });

  it('should emit exactly one structured INFO log for updated, unchanged, and failed paths', async () => {
    const updatedClient = createClient(successResult('2026-07-13T10:05:00.000Z'));
    await refresh({ ledgerClient: updatedClient, fetchedAt: startTime });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(infoSpy.mock.calls[0][1] as string)).toMatchObject({
      deviceId,
      productId,
      ledgerName: ParticleLedgerNames.deviceStatus,
      ledgerUpdatedAt: '2026-07-13T10:05:00.000Z',
      result: 'updated',
      elapsedMs: expect.any(Number),
    });

    clearDeviceProductIdCacheForTests();
    jest.clearAllMocks();
    const unchangedClient = createClient(successResult('2026-07-13T10:05:00.000Z'));
    await refresh({ previous: createPrevious('2026-07-13T10:05:00.000Z'), ledgerClient: unchangedClient, fetchedAt: startTime });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(infoSpy.mock.calls[0][1] as string)).toMatchObject({ result: 'unchanged' });

    clearDeviceProductIdCacheForTests();
    jest.clearAllMocks();
    const failedClient = createClient(failureResult('retryable_failure', 429));
    await refresh({ ledgerClient: failedClient, fetchedAt: startTime });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(infoSpy.mock.calls[0][1] as string)).toMatchObject({
      result: 'failed',
      httpStatus: 429,
    });
  });
});
