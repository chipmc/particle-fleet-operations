// Ledger identifiers are part of the firmware/cloud contract and must stay synchronized with the Generalized Core Counter firmware and the Ledger Architecture ADR.
export const ParticleLedgerNames = {
  productDefault: 'default-settings',
  deviceSettings: 'device-settings',
  deviceStatus: 'device-status',
  deviceData: 'device-data',
} as const;

export type ParticleLedgerName = (typeof ParticleLedgerNames)[keyof typeof ParticleLedgerNames];

export type ParticleLedgerErrorKind =
  | 'auth_failure'
  | 'missing_ledger'
  | 'retryable_failure'
  | 'network_failure'
  | 'malformed_json'
  | 'permanent_failure';

export type ParticleLedgerJson = Record<string, unknown>;

export interface ParticleLedgerInstance<T extends ParticleLedgerJson = ParticleLedgerJson> {
  name?: string;
  scope?: {
    type?: string;
    value?: string;
    name?: string;
    not_owned?: boolean;
  };
  size_bytes?: number;
  data: T;
  updated_at?: string;
  created_at?: string;
}

export interface ParticleLedgerSuccess<T extends ParticleLedgerJson = ParticleLedgerJson> {
  ok: true;
  ledgerName: ParticleLedgerName;
  scopeValue: string;
  data: T;
  instance: ParticleLedgerInstance<T>;
}

export interface ParticleLedgerFailure {
  ok: false;
  ledgerName: ParticleLedgerName;
  scopeValue: string;
  error: {
    kind: ParticleLedgerErrorKind;
    message: string;
    retryable: boolean;
    httpStatus?: number;
  };
}

export type ParticleLedgerResult<T extends ParticleLedgerJson = ParticleLedgerJson> =
  | ParticleLedgerSuccess<T>
  | ParticleLedgerFailure;

export interface ParticleLedgerClientOptions {
  accessToken?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface ParticleLedgerApiResponse<T extends ParticleLedgerJson> {
  instance?: ParticleLedgerInstance<T>;
}

const DEFAULT_PARTICLE_API_BASE_URL = 'https://api.particle.io';
const DEFAULT_TIMEOUT_MS = 5000;

export class ParticleLedgerClient {
  constructor(private readonly options: ParticleLedgerClientOptions = {}) {}

  getDeviceStatus<T extends ParticleLedgerJson = ParticleLedgerJson>(deviceId: string): Promise<ParticleLedgerResult<T>> {
    return this.getLedgerInstance<T>(ParticleLedgerNames.deviceStatus, deviceId);
  }

  getDeviceData<T extends ParticleLedgerJson = ParticleLedgerJson>(deviceId: string): Promise<ParticleLedgerResult<T>> {
    return this.getLedgerInstance<T>(ParticleLedgerNames.deviceData, deviceId);
  }

  getDeviceSettings<T extends ParticleLedgerJson = ParticleLedgerJson>(deviceId: string): Promise<ParticleLedgerResult<T>> {
    return this.getLedgerInstance<T>(ParticleLedgerNames.deviceSettings, deviceId);
  }

  getProductDefaults<T extends ParticleLedgerJson = ParticleLedgerJson>(productId: string): Promise<ParticleLedgerResult<T>> {
    return this.getLedgerInstance<T>(ParticleLedgerNames.productDefault, productId);
  }

  private async getLedgerInstance<T extends ParticleLedgerJson>(
    ledgerName: ParticleLedgerName,
    scopeValue: string
  ): Promise<ParticleLedgerResult<T>> {
    const accessToken = this.options.accessToken ?? process.env.PARTICLE_ACCESS_TOKEN;
    if (!accessToken) {
      return this.failure(ledgerName, scopeValue, 'auth_failure', 'Particle access token is not configured', false);
    }

    const fetchFn = this.options.fetchFn ?? fetch;
    const apiBaseUrl = (this.options.apiBaseUrl || process.env.PARTICLE_API_BASE_URL || DEFAULT_PARTICLE_API_BASE_URL)
      .replace(/\/+$/, '');
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchFn(`${apiBaseUrl}${buildLedgerInstancePath(ledgerName, scopeValue)}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.httpFailure(ledgerName, scopeValue, response.status);
      }

      const text = await response.text();
      if (text.trim().length === 0) {
        return this.failure(ledgerName, scopeValue, 'malformed_json', 'Particle ledger response body was empty', false);
      }

      let payload: ParticleLedgerApiResponse<T>;
      try {
        payload = JSON.parse(text) as ParticleLedgerApiResponse<T>;
      } catch {
        return this.failure(ledgerName, scopeValue, 'malformed_json', 'Particle ledger response body was not valid JSON', false);
      }

      if (!payload.instance || !isRecord(payload.instance.data)) {
        return this.failure(ledgerName, scopeValue, 'permanent_failure', 'Particle ledger response missing instance data', false);
      }

      return {
        ok: true,
        ledgerName,
        scopeValue,
        data: payload.instance.data,
        instance: payload.instance,
      };
    } catch (err) {
      const message = isAbortError(err)
        ? 'Particle ledger request timed out'
        : 'Particle ledger request failed before receiving a response';
      return this.failure(ledgerName, scopeValue, 'network_failure', message, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private httpFailure(
    ledgerName: ParticleLedgerName,
    scopeValue: string,
    httpStatus: number
  ): ParticleLedgerFailure {
    if (httpStatus === 401 || httpStatus === 403) {
      return this.failure(ledgerName, scopeValue, 'auth_failure', 'Particle rejected ledger authentication', false, httpStatus);
    }

    if (httpStatus === 404) {
      return this.failure(ledgerName, scopeValue, 'missing_ledger', 'Particle ledger instance was not found', false, httpStatus);
    }

    if ([408, 429, 500, 502, 503, 504].includes(httpStatus)) {
      return this.failure(ledgerName, scopeValue, 'retryable_failure', 'Particle ledger service returned a retryable failure', true, httpStatus);
    }

    return this.failure(ledgerName, scopeValue, 'permanent_failure', 'Particle ledger service returned a non-retryable failure', false, httpStatus);
  }

  private failure(
    ledgerName: ParticleLedgerName,
    scopeValue: string,
    kind: ParticleLedgerErrorKind,
    message: string,
    retryable: boolean,
    httpStatus?: number
  ): ParticleLedgerFailure {
    const result: ParticleLedgerFailure = {
      ok: false,
      ledgerName,
      scopeValue,
      error: {
        kind,
        message,
        retryable,
        ...(httpStatus !== undefined && { httpStatus }),
      },
    };

    console.warn(
      'Particle ledger request failed',
      JSON.stringify({ ledgerName, scopeValue, errorKind: kind, httpStatus })
    );

    return result;
  }
}

export function getDeviceStatus<T extends ParticleLedgerJson = ParticleLedgerJson>(
  deviceId: string
): Promise<ParticleLedgerResult<T>> {
  return new ParticleLedgerClient().getDeviceStatus<T>(deviceId);
}

export function getDeviceData<T extends ParticleLedgerJson = ParticleLedgerJson>(
  deviceId: string
): Promise<ParticleLedgerResult<T>> {
  return new ParticleLedgerClient().getDeviceData<T>(deviceId);
}

export function getDeviceSettings<T extends ParticleLedgerJson = ParticleLedgerJson>(
  deviceId: string
): Promise<ParticleLedgerResult<T>> {
  return new ParticleLedgerClient().getDeviceSettings<T>(deviceId);
}

export function getProductDefaults<T extends ParticleLedgerJson = ParticleLedgerJson>(
  productId: string
): Promise<ParticleLedgerResult<T>> {
  return new ParticleLedgerClient().getProductDefaults<T>(productId);
}

function buildLedgerInstancePath(ledgerName: ParticleLedgerName, scopeValue: string): string {
  return `/v1/ledgers/${encodeURIComponent(ledgerName)}/instances/${encodeURIComponent(scopeValue)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError';
}
