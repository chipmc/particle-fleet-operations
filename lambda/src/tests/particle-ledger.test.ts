import {
  ParticleLedgerClient,
  ParticleLedgerErrorKind,
  ParticleLedgerNames,
  ParticleLedgerResult,
} from '../integrations/particle-ledger';

const fetchMock = jest.fn();
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
const CREATED_AT = '2026-07-10T00:00:00.000Z';
const UPDATED_AT = '2026-07-10T00:00:00.000Z';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(text),
  } as unknown as Response;
}

function ledgerResponse(
  name: string,
  scopeType: 'Device' | 'Product',
  scopeValue: string,
  data: Record<string, unknown>,
  sizeBytes: number = 123
): Response {
  return jsonResponse(200, {
    instance: {
      scope: {
        type: scopeType,
        value: scopeValue,
      },
      name,
      size_bytes: sizeBytes,
      data,
      updated_at: UPDATED_AT,
      created_at: CREATED_AT,
    },
  });
}

function createClient(timeoutMs: number = 5000): ParticleLedgerClient {
  return new ParticleLedgerClient({
    accessToken: 'particle-token',
    apiBaseUrl: 'https://particle.example.test/',
    timeoutMs,
    fetchFn: fetchMock as unknown as typeof fetch,
  });
}

function expectFailure(
  result: ParticleLedgerResult,
  kind: ParticleLedgerErrorKind,
  retryable: boolean,
  httpStatus?: number
): void {
  expect(result).toMatchObject({
    ok: false,
    error: {
      kind,
      retryable,
      ...(httpStatus !== undefined && { httpStatus }),
    },
  });
}

describe('Particle Ledger client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('should return Device Status ledger data', async () => {
    const data = {
      schemaVersion: 1,
      firmware: { version: '2.5.1' },
      connection: { state: 'connected' },
    };
    fetchMock.mockResolvedValue(ledgerResponse(ParticleLedgerNames.deviceStatus, 'Device', 'device123', data));

    const result = await createClient().getDeviceStatus('device123');

    expect(result).toMatchObject({
      ok: true,
      ledgerName: ParticleLedgerNames.deviceStatus,
      scopeValue: 'device123',
      data,
      instance: {
        name: ParticleLedgerNames.deviceStatus,
        scope: { type: 'Device', value: 'device123' },
        size_bytes: 123,
        data,
        updated_at: UPDATED_AT,
        created_at: CREATED_AT,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://particle.example.test/v1/ledgers/device-status/instances/device123',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer particle-token',
          Accept: 'application/json',
        },
      })
    );
  });

  it('should return Device Data ledger data', async () => {
    const data = {
      schemaVersion: 1,
      observation: { occupancy: 12 },
    };
    fetchMock.mockResolvedValue(ledgerResponse(ParticleLedgerNames.deviceData, 'Device', 'device123', data));

    const result = await createClient().getDeviceData('device123');

    expect(result).toMatchObject({
      ok: true,
      ledgerName: ParticleLedgerNames.deviceData,
      scopeValue: 'device123',
      data,
      instance: {
        name: ParticleLedgerNames.deviceData,
        scope: { type: 'Device', value: 'device123' },
        size_bytes: 123,
        data,
        updated_at: UPDATED_AT,
        created_at: CREATED_AT,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://particle.example.test/v1/ledgers/device-data/instances/device123',
      expect.any(Object)
    );
  });

  it.each([401, 403])('should classify HTTP %i as auth failure', async (status) => {
    fetchMock.mockResolvedValue(textResponse(status, '{}'));

    const result = await createClient().getDeviceStatus('device123');

    expectFailure(result, 'auth_failure', false, status);
  });

  it('should classify HTTP 404 as a missing ledger', async () => {
    fetchMock.mockResolvedValue(textResponse(404, '{}'));

    const result = await createClient().getDeviceStatus('device123');

    expectFailure(result, 'missing_ledger', false, 404);
  });

  it.each([429, 500, 503])('should classify HTTP %i as a retryable service failure', async (status) => {
    fetchMock.mockResolvedValue(textResponse(status, '{}'));

    const result = await createClient().getDeviceStatus('device123');

    expectFailure(result, 'retryable_failure', true, status);
  });

  it('should classify request timeout as a retryable network failure', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));

    const resultPromise = createClient(100).getDeviceStatus('device123');
    jest.advanceTimersByTime(100);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'network_failure',
        retryable: true,
      },
    });
    jest.useRealTimers();
  });

  it('should classify connection reset as a retryable network failure', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    const result = await createClient().getDeviceStatus('device123');

    expectFailure(result, 'network_failure', true);
  });

  it('should classify invalid JSON as a malformed response', async () => {
    fetchMock.mockResolvedValue(textResponse(200, '{not-json'));

    const result = await createClient().getDeviceStatus('device123');

    expectFailure(result, 'malformed_json', false);
  });

  it('should classify an empty response body as malformed JSON', async () => {
    fetchMock.mockResolvedValue(textResponse(200, ''));

    const result = await createClient().getDeviceStatus('device123');

    expectFailure(result, 'malformed_json', false);
  });

  it('should not call Particle when the access token is missing', async () => {
    const client = new ParticleLedgerClient({
      accessToken: '',
      apiBaseUrl: 'https://particle.example.test',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.getDeviceStatus('device123');

    expectFailure(result, 'auth_failure', false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should expose stable methods for Device Settings and Product Default ledgers', async () => {
    fetchMock
      .mockResolvedValueOnce(ledgerResponse(
        ParticleLedgerNames.deviceSettings,
        'Device',
        'device123',
        { reporting: { intervalMinutes: 60 } }
      ))
      .mockResolvedValueOnce(ledgerResponse(
        ParticleLedgerNames.productDefault,
        'Product',
        '12345',
        { config: { profile: 'default' } }
      ));

    await expect(createClient().getDeviceSettings('device123')).resolves.toMatchObject({
      ok: true,
      ledgerName: ParticleLedgerNames.deviceSettings,
      scopeValue: 'device123',
      data: { reporting: { intervalMinutes: 60 } },
      instance: {
        name: ParticleLedgerNames.deviceSettings,
        scope: { type: 'Device', value: 'device123' },
      },
    });
    await expect(createClient().getProductDefaults('12345')).resolves.toMatchObject({
      ok: true,
      ledgerName: ParticleLedgerNames.productDefault,
      scopeValue: '12345',
      data: { config: { profile: 'default' } },
      instance: {
        name: ParticleLedgerNames.productDefault,
        scope: { type: 'Product', value: '12345' },
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://particle.example.test/v1/ledgers/device-settings/instances/device123',
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://particle.example.test/v1/ledgers/default-settings/instances/12345',
      expect.any(Object)
    );
  });
});
