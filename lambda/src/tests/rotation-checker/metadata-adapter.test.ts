/**
 * Metadata-adapter boundary fixtures (WO-2026-09-30-001 design, Revisions 5 and 6). The
 * adapter is the only place an API Gateway response or exception exists in the checker. These
 * tests assert the exact value that leaves it -- fresh records labeled only with the
 * registry's consumer ID and slot, plus enabled and createdDate, or a fixed failure code --
 * for hostile successful pages and hostile failures. They do not watch output channels: once
 * nothing upstream crosses this boundary, no downstream output can carry it.
 *
 * Revision 6 (R3-1): a key's `id` is never read, and its raw `name` is used only for an exact
 * lookup and never returned. Sentinels are placed separately in `id`, `value`, and unmatched
 * `name`, including IDs that satisfy any ID pattern ever proposed; nothing here asserts an
 * ID's length or shape, because the design forbids depending on one.
 *
 * Two levels: object-level (APIGatewayClient.prototype.send stubbed) for shapes JSON can't
 * carry -- getters, symbols, non-enumerable properties, a Proxy that records every access --
 * and wire-level (a local fake endpoint through the real SDK deserializer).
 */
import { APIGatewayClient, GetApiKeysCommand } from '@aws-sdk/client-api-gateway';
import { listKeyMetadata } from '../../rotation-checker/metadata-adapter';
import { expectedKeySlots } from '../../rotation-checker/rotation-core';
import { KeyMetadataReadResult } from '../../rotation-checker/records';
import { VALUE_SENTINEL, allOwnKeys, findSentinel } from '../helpers/sentinel';
import { FakeAwsEndpoint, apiKeysPage, awsEnvFor, epochSeconds, startFakeAwsEndpoint } from '../helpers/fake-aws-endpoint';

const ALPHA = 'particle-ingestion-alpha';
const ALPHA_B = 'particle-ingestion-alpha-b';
const EXPECTED = expectedKeySlots([{ id: 'alpha', apiKey: { primarySlot: 'a' } }]);
const CREATED = '2026-09-21T15:34:04+08:00';

/**
 * Credential-shaped strings placed in `id`: one plain sentinel, one that satisfies the
 * withdrawn `^[A-Za-z0-9-]{1,64}$` pattern, one shaped like a real 10-character key ID, and one
 * the length of a generated key value. Each must be absent from every boundary value.
 */
const ID_SENTINELS = [`id-${VALUE_SENTINEL}`, 'IDSENTINEL0aZ9patternmatchingvalue0123456789', 'idsntnl0k9', 'IDSENTINELgeneratedLength40chars00000000'];

const originalEnv = process.env;
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

function stubSend(impl: (command: unknown) => Promise<unknown>): jest.SpyInstance {
  return jest.spyOn(APIGatewayClient.prototype, 'send').mockImplementation(impl as never);
}

function expectNoLeak(value: unknown): void {
  for (const sentinel of [VALUE_SENTINEL, ...ID_SENTINELS]) expect({ sentinel, hits: findSentinel(value, sentinel) }).toEqual({ sentinel, hits: [] });
}

function expectExactSlots(result: KeyMetadataReadResult, expected: { consumerId: string; slot: 'a' | 'b'; enabled: boolean; createdDate: string }[]): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.slots.map(s => ({ ...s, createdDate: s.createdDate.toISOString() }))).toEqual(
    expected.map(e => ({ ...e, createdDate: new Date(e.createdDate).toISOString() })));
  for (const record of result.slots) {
    expect(allOwnKeys(record).sort()).toEqual(['consumerId', 'createdDate', 'enabled', 'slot']);
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(allOwnKeys(record.createdDate)).toEqual([]);
    expect(Object.getPrototypeOf(record.createdDate)).toBe(Date.prototype);
  }
  expectNoLeak(result);
}

describe('requests: one value-free command, paginated', () => {
  test('sends only GetApiKeysCommand with includeValues: false, and passes opaque positions through unchanged', async () => {
    const tokens = ['opaque/Token+==', 'x:y:z'];
    const sent: unknown[] = [];
    stubSend(async command => {
      sent.push(command);
      const page = sent.length - 1;
      if (page === 2) return { items: [] };
      return { items: [{ id: ID_SENTINELS[page], name: page === 0 ? ALPHA : ALPHA_B, enabled: true, createdDate: new Date(CREATED) }], position: tokens[page] };
    });
    const result = await listKeyMetadata(EXPECTED);
    expect(sent).toHaveLength(3);
    for (const command of sent) expect(command).toBeInstanceOf(GetApiKeysCommand);
    expect(sent.map(c => (c as GetApiKeysCommand).input)).toEqual([
      { includeValues: false, limit: 500, position: undefined },
      { includeValues: false, limit: 500, position: tokens[0] },
      { includeValues: false, limit: 500, position: tokens[1] },
    ]);
    expectExactSlots(result, [
      { consumerId: 'alpha', slot: 'a', enabled: true, createdDate: CREATED },
      { consumerId: 'alpha', slot: 'b', enabled: true, createdDate: CREATED },
    ]);
  });

  test('a repeated position fails closed instead of looping', async () => {
    stubSend(async () => ({ items: [], position: 'same' }));
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: false, failure: 'invalid_metadata_page' });
  });

  test('runaway pagination is cut off with a fixed failure, not a partial result', async () => {
    let n = 0;
    stubSend(async () => ({ items: [], position: `p${n++}` }));
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: false, failure: 'pagination_limit_exceeded' });
    expect(n).toBe(100);
  });
});

describe('Revision 6: neither the key ID nor the raw name crosses the boundary', () => {
  test('the adapter reads only name, enabled and createdDate -- never id, never value', async () => {
    const reads: string[] = [];
    const item = new Proxy({ id: ID_SENTINELS[0], name: ALPHA, enabled: true, createdDate: new Date(CREATED), value: VALUE_SENTINEL }, {
      get: (target, key, receiver) => { reads.push(`get ${String(key)}`); return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor: (target, key) => { reads.push(`descriptor ${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      has: (target, key) => { reads.push(`has ${String(key)}`); return Reflect.has(target, key); },
      ownKeys: target => { reads.push('ownKeys'); return Reflect.ownKeys(target); },
    });
    stubSend(async () => ({ items: [item] }));
    const result = await listKeyMetadata(EXPECTED);
    expectExactSlots(result, [{ consumerId: 'alpha', slot: 'a', enabled: true, createdDate: CREATED }]);
    expect([...new Set(reads)].sort()).toEqual(['descriptor createdDate', 'descriptor enabled', 'descriptor name']);
  });

  test.each(ID_SENTINELS.map(id => [id]))('a credential-shaped id (%s) never crosses, whatever its shape', async id => {
    stubSend(async () => ({ items: [{ id, name: ALPHA_B, enabled: false, createdDate: new Date(CREATED) }] }));
    const result = await listKeyMetadata(EXPECTED);
    expectExactSlots(result, [{ consumerId: 'alpha', slot: 'b', enabled: false, createdDate: CREATED }]);
    expect(JSON.stringify(result)).not.toContain(id);
  });

  test('a key with no id at all, or an id of any type, is still observed: id is simply not part of the contract', async () => {
    stubSend(async () => ({ items: [
      { name: ALPHA, enabled: true, createdDate: new Date(CREATED) },
      { id: { nested: VALUE_SENTINEL }, name: ALPHA_B, enabled: true, createdDate: new Date(CREATED) },
    ] }));
    expectExactSlots(await listKeyMetadata(EXPECTED), [
      { consumerId: 'alpha', slot: 'a', enabled: true, createdDate: CREATED },
      { consumerId: 'alpha', slot: 'b', enabled: true, createdDate: CREATED },
    ]);
  });

  test('unmatched raw names carrying the value are ignored without being copied or reported', async () => {
    stubSend(async () => ({ items: [
      { id: ID_SENTINELS[1], name: `particle-ingestion-${VALUE_SENTINEL}`, enabled: true, createdDate: new Date(CREATED) },
      { id: ID_SENTINELS[2], name: VALUE_SENTINEL, enabled: true, createdDate: new Date(CREATED) },
      { id: ID_SENTINELS[3], name: `${ALPHA}-${VALUE_SENTINEL}`, enabled: true, createdDate: new Date(CREATED) },
    ] }));
    const result = await listKeyMetadata(EXPECTED);
    expect(result).toEqual({ ok: true, slots: [], malformed: [] });
    expectNoLeak(result);
  });

  test('a matched key is labeled by the registry, not by the response: the raw name string is not returned', async () => {
    stubSend(async () => ({ items: [{ name: ALPHA_B, enabled: true, createdDate: new Date(CREATED) }] }));
    const result = await listKeyMetadata(EXPECTED);
    expect(JSON.stringify(result)).not.toContain('particle-ingestion');
  });
});

describe('hostile successful pages: only approved fields ever cross', () => {
  test('value, nested and enumerable extras, non-enumerable and symbol properties, getters, and a decorated Date are all dropped', async () => {
    let unapprovedGetterCalls = 0;
    const createdDate = Object.assign(new Date(CREATED), { leaked: VALUE_SENTINEL });
    const item: Record<string | symbol, unknown> = {
      id: ID_SENTINELS[0],
      name: ALPHA_B,
      enabled: false,
      createdDate,
      value: VALUE_SENTINEL,
      description: VALUE_SENTINEL,
      tags: { secret: VALUE_SENTINEL, nested: { deeper: [VALUE_SENTINEL] } },
      stageKeys: [VALUE_SENTINEL],
      [Symbol(VALUE_SENTINEL)]: VALUE_SENTINEL,
    };
    Object.defineProperty(item, 'hidden', { value: VALUE_SENTINEL, enumerable: false });
    Object.defineProperty(item, 'lazy', { get: () => { unapprovedGetterCalls++; return VALUE_SENTINEL; }, enumerable: true });
    const page = Object.assign(Object.create({ inherited: VALUE_SENTINEL }), { items: [item], [VALUE_SENTINEL]: VALUE_SENTINEL, $metadata: { requestId: VALUE_SENTINEL } });
    stubSend(async () => page);

    const result = await listKeyMetadata(EXPECTED);

    expectExactSlots(result, [{ consumerId: 'alpha', slot: 'b', enabled: false, createdDate: CREATED }]);
    expect(allOwnKeys(result).sort()).toEqual(['malformed', 'ok', 'slots']);
    if (result.ok) expect(result.slots[0].createdDate).not.toBe(createdDate);
    expect(unapprovedGetterCalls).toBe(0);
  });

  test('an approved field behind a getter is malformed, and the getter is never evaluated', async () => {
    let calls = 0;
    const item = { id: ID_SENTINELS[0], name: ALPHA, enabled: true };
    Object.defineProperty(item, 'createdDate', { get: () => { calls++; return new Date(CREATED); }, enumerable: true });
    stubSend(async () => ({ items: [item] }));
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: true, slots: [], malformed: [{ consumerId: 'alpha', slot: 'a', reason: 'invalid_key_metadata' }] });
    expect(calls).toBe(0);
  });

  test('a Date carrying a Symbol.toStringTag getter (or any getter) is projected without running it', async () => {
    let calls = 0;
    const createdDate = new Date(CREATED);
    Object.defineProperty(createdDate, Symbol.toStringTag, { get: () => { calls++; return 'Date'; } });
    Object.defineProperty(createdDate, 'getTime', { get: () => { calls++; return () => 0; } });
    stubSend(async () => ({ items: [{ name: ALPHA, enabled: true, createdDate }] }));
    expectExactSlots(await listKeyMetadata(EXPECTED), [{ consumerId: 'alpha', slot: 'a', enabled: true, createdDate: CREATED }]);
    expect(calls).toBe(0);
  });

  test('an object pretending to be a Date is rejected without running any of its code', async () => {
    let calls = 0;
    const fake = Object.create(Date.prototype, { [Symbol.toStringTag]: { get: () => { calls++; return 'Date'; } } });
    stubSend(async () => ({ items: [{ name: ALPHA, enabled: true, createdDate: fake }] }));
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: true, slots: [], malformed: [{ consumerId: 'alpha', slot: 'a', reason: 'missing_created_date' }] });
    expect(calls).toBe(0);
  });

  test('keys with other names are skipped after reading only their name', async () => {
    let calls = 0;
    const trap = () => { calls++; return VALUE_SENTINEL; };
    const other = { name: 'particle-ingestion-alpha-long' };
    for (const field of ['id', 'enabled', 'createdDate', 'value']) Object.defineProperty(other, field, { get: trap, enumerable: true });
    stubSend(async () => ({ items: [other, { name: 'particle-ingestion-alph' }, { id: 'no-name' }] }));
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: true, slots: [], malformed: [] });
    expect(calls).toBe(0);
  });

  test.each([
    ['missing createdDate', { name: ALPHA, enabled: true }, 'missing_created_date'],
    ['unparseable createdDate', { name: ALPHA, enabled: true, createdDate: 'last tuesday' }, 'missing_created_date'],
    ['offset-less createdDate', { name: ALPHA, enabled: true, createdDate: '2026-09-21T15:34:04' }, 'missing_created_date'],
    ['invalid Date', { name: ALPHA, enabled: true, createdDate: new Date('nope') }, 'missing_created_date'],
    ['non-boolean enabled', { name: ALPHA, enabled: 'true', createdDate: new Date(CREATED) }, 'invalid_key_metadata'],
  ])('an attributable key with %s becomes a closed malformed reason under its registry label', async (_label, item, reason) => {
    stubSend(async () => ({ items: [{ ...item, id: ID_SENTINELS[1], value: VALUE_SENTINEL }] }));
    const result = await listKeyMetadata(EXPECTED);
    expect(result).toEqual({ ok: true, slots: [], malformed: [{ consumerId: 'alpha', slot: 'a', reason }] });
    expectNoLeak(result);
  });

  test.each([
    ['a non-object page', 'not a page'],
    ['items that is not an array', { items: { 0: {} } }],
    ['a non-object item', { items: [VALUE_SENTINEL] }],
    ['an item whose name is a getter', { items: [Object.defineProperty({}, 'name', { get: () => ALPHA, enumerable: true })] }],
    ['a non-string position', { items: [], position: 42 }],
  ])('%s fails the whole read with a fixed code', async (_label, page) => {
    stubSend(async () => page);
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: false, failure: 'invalid_metadata_page' });
  });
});

describe('hostile failures: the caught error is never inspected', () => {
  test('an error carrying the value in name, message, stack, cause, request ID, $metadata, and own/symbol properties yields only a fixed code', async () => {
    const error = new Error(`message ${VALUE_SENTINEL}`, { cause: new Error(VALUE_SENTINEL, { cause: { deeper: VALUE_SENTINEL } }) });
    error.name = `Name${VALUE_SENTINEL}`;
    error.stack = `stack ${VALUE_SENTINEL}`;
    Object.assign(error, { $metadata: { requestId: VALUE_SENTINEL, httpStatusCode: 400 }, requestId: VALUE_SENTINEL, Code: VALUE_SENTINEL, [Symbol(VALUE_SENTINEL)]: VALUE_SENTINEL });
    Object.defineProperty(error, 'hidden', { value: VALUE_SENTINEL, enumerable: false });
    stubSend(async () => { throw error; });
    const result = await listKeyMetadata(EXPECTED);
    expect(result).toEqual({ ok: false, failure: 'api_gateway_read_failed' });
    expect(allOwnKeys(result).sort()).toEqual(['failure', 'ok']);
    expectNoLeak(result);
  });

  test('an error that records every access is never touched at all', async () => {
    const touched: string[] = [];
    const watcher = new Proxy({}, {
      get: (_t, key) => { touched.push(`get ${String(key)}`); return undefined; },
      has: (_t, key) => { touched.push(`has ${String(key)}`); return false; },
      ownKeys: () => { touched.push('ownKeys'); return []; },
      getOwnPropertyDescriptor: (_t, key) => { touched.push(`descriptor ${String(key)}`); return undefined; },
      getPrototypeOf: () => { touched.push('getPrototypeOf'); return null; },
    });
    stubSend(async () => { throw watcher; });
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: false, failure: 'api_gateway_read_failed' });
    expect(touched).toEqual([]);
  });

  test('a non-Error rejection (a bare string carrying the value) yields only a fixed code', async () => {
    stubSend(() => Promise.reject(VALUE_SENTINEL));
    expect(await listKeyMetadata(EXPECTED)).toEqual({ ok: false, failure: 'api_gateway_read_failed' });
  });
});

describe('wire level, through the real SDK deserializer', () => {
  let endpoint: FakeAwsEndpoint;
  beforeEach(async () => {
    endpoint = await startFakeAwsEndpoint();
    process.env = { ...awsEnvFor(endpoint.url) };
  });
  afterEach(async () => endpoint.close());

  test('API Gateway\'s wire shape (`item`, epoch seconds) yields exact labeled records; ids and values on the wire never cross', async () => {
    endpoint.getApiKeys = query => query.position === 'page-2'
      ? apiKeysPage([
        { id: ID_SENTINELS[3], name: ALPHA_B, enabled: false, createdDate: epochSeconds(CREATED), value: VALUE_SENTINEL, description: VALUE_SENTINEL, tags: { k: VALUE_SENTINEL } },
        { id: ID_SENTINELS[2], name: `other-${VALUE_SENTINEL}`, enabled: true, createdDate: epochSeconds(CREATED), value: VALUE_SENTINEL },
      ])
      : apiKeysPage([{ id: ID_SENTINELS[1], name: ALPHA, enabled: true, createdDate: epochSeconds('2026-03-01T12:00:00Z'), value: VALUE_SENTINEL, lastUpdatedDate: epochSeconds('2026-09-30T00:00:00Z') }], 'page-2');
    const result = await listKeyMetadata(EXPECTED);
    expectExactSlots(result, [
      { consumerId: 'alpha', slot: 'a', enabled: true, createdDate: '2026-03-01T12:00:00Z' },
      { consumerId: 'alpha', slot: 'b', enabled: false, createdDate: CREATED },
    ]);
    expect(endpoint.requests.map(r => `${r.method} ${r.path}`)).toEqual(['GET /apikeys', 'GET /apikeys']);
    expect(endpoint.requests.map(r => r.query)).toEqual([
      { includeValues: 'false', limit: '500' },
      { includeValues: 'false', limit: '500', position: 'page-2' },
    ]);
  });

  test.each([
    ['error type header', { 'x-amzn-errortype': `BadRequest${VALUE_SENTINEL}:http://internal.amazon.com/coral/` }, '{"message":"bad"}'],
    ['error message body', { 'x-amzn-errortype': 'BadRequestException' }, JSON.stringify({ message: VALUE_SENTINEL, Message: VALUE_SENTINEL })],
    ['request ID header', { 'x-amzn-errortype': 'TooManyRequestsException', 'x-amzn-requestid': VALUE_SENTINEL }, '{}'],
    ['unparseable error body', { 'x-amzn-errortype': 'UnauthorizedException' }, `<html>${VALUE_SENTINEL}`],
  ])('an API Gateway error carrying the value in its %s yields only a fixed code', async (_label, headers, body) => {
    endpoint.getApiKeys = () => ({ status: 400, headers: { 'content-type': 'application/json', ...headers }, body });
    const result = await listKeyMetadata(EXPECTED);
    expect(result).toEqual({ ok: false, failure: 'api_gateway_read_failed' });
    expectNoLeak(result);
  });

  test('a malformed success body yields only a fixed code', async () => {
    endpoint.getApiKeys = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: `{"item": [${VALUE_SENTINEL}` });
    const result = await listKeyMetadata(EXPECTED);
    expect(result.ok).toBe(false);
    expectNoLeak(result);
  });
});
