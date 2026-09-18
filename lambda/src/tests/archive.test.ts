import { gunzipSync } from 'zlib';
import { canonicalSerialize, processArchivePage } from '../archive';

function testDependencies(items: Record<string, unknown>[]) {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    scan: jest.fn<Promise<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>, []>(async () => ({ Items: items })),
    putObject: jest.fn(async input => {
      objects.set(String(input.Key), Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(String(input.Body)));
    }),
    getObject: jest.fn(async input => objects.get(String(input.Key)) || Buffer.alloc(0)),
    batchGet: jest.fn(async () => items),
    deleteItem: jest.fn(async () => undefined),
  };
}

const env = {
  LOG_EVENTS_TABLE_NAME: 'log-events',
  RAW_LOGS_BUCKET_NAME: 'archive-bucket',
  ARCHIVE_DELETE_ENABLED: 'false',
};

describe('monthly archive copy and verification', () => {
  test('archives mixed timestamp formats by parsed instant and performs no deletion in dry-run mode', async () => {
    const items = [
      { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.123456+00:00', eventName: 'serialLog', battery: 42 },
      { deviceId: 'device-b', eventTime: '2026-06-02T12:00:00.123Z', eventName: 'status', nested: { z: 1, a: true } },
      { deviceId: 'device-c', eventTime: '2026-09-01T00:00:00.000Z', eventName: 'new' },
    ];
    const deps = testDependencies(items);

    const result = await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, env);

    expect(result).toMatchObject({ examined: 3, eligible: 2, copied: 2, alreadyArchived: 0, verified: 2, deleted: 0, retained: 0, complete: true });
    expect(deps.deleteItem).not.toHaveBeenCalled();
    expect(deps.batchGet).toHaveBeenCalled();
    const dataObjects = [...deps.objects.entries()].filter(([key]) => key.endsWith('.jsonl.gz'));
    expect(dataObjects).toHaveLength(2);
    const archived = dataObjects.flatMap(([, body]) => gunzipSync(body).toString('utf8').trim().split('\n').map(line => JSON.parse(line)));
    expect(archived.map(line => line.item.deviceId).sort()).toEqual(['device-a', 'device-b']);
  });

  test('retains a row changed between copy and pre-delete reread', async () => {
    const original = { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.000Z', battery: 42 };
    const deps = testDependencies([original]);
    deps.batchGet.mockResolvedValue([{ ...original, battery: 43 }]);

    const result = await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, { ...env, ARCHIVE_DELETE_ENABLED: 'true' });

    expect(result).toMatchObject({ copied: 1, verified: 0, deleted: 0, retained: 1 });
    expect(deps.deleteItem).not.toHaveBeenCalled();
  });

  test('deletes only reread-identical rows when explicitly enabled', async () => {
    const item = { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.000Z', battery: 42 };
    const deps = testDependencies([item]);

    const result = await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, { ...env, ARCHIVE_DELETE_ENABLED: 'true' });

    expect(result.deleted).toBe(1);
    expect(deps.deleteItem).toHaveBeenCalledWith({
      TableName: 'log-events',
      Key: { deviceId: 'device-a', eventTime: item.eventTime },
    });
  });

  test('canonical serialization is stable across object key order', () => {
    expect(canonicalSerialize({ z: 1, a: { y: 2, x: 3 } }))
      .toBe(canonicalSerialize({ a: { x: 3, y: 2 }, z: 1 }));
  });

  test('retains an unserializable eligible row while continuing other shards', async () => {
    const items = [
      { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.000Z', battery: 42 },
      { deviceId: 'device-b', eventTime: '2026-06-01T12:00:01.000Z', invalid: Number.NaN },
    ];
    const deps = testDependencies(items);

    const result = await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, env);

    expect(result).toMatchObject({ eligible: 2, copied: 1, verified: 1, retained: 1 });
    expect(result.failures).toEqual([expect.objectContaining({ partition: 'unsharded' })]);
    expect(deps.deleteItem).not.toHaveBeenCalled();
  });

  test('returns the scan cursor for the workflow to process the next page', async () => {
    const item = { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.000Z' };
    const deps = testDependencies([item]);
    deps.scan.mockResolvedValue({ Items: [item], LastEvaluatedKey: { deviceId: 'device-a', eventTime: item.eventTime } });

    const result = await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
      exclusiveStartKey: null,
    }, deps, env);

    expect(result.complete).toBe(false);
    expect(result.lastEvaluatedKey).toEqual({ deviceId: 'device-a', eventTime: item.eventTime });
    expect(result.logicalBytes).toBeGreaterThan(result.compressedBytes);
    expect(result.retryCount).toBe(0);
  });

  test('accepts an identical immutable object on rerun and reports it as already archived', async () => {
    const item = { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.000Z' };
    const deps = testDependencies([item]);
    await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, env);
    deps.putObject.mockImplementation(async input => {
      const error = Object.assign(new Error('Precondition failed'), { $metadata: { httpStatusCode: 412 } });
      if (deps.objects.has(String(input.Key))) throw error;
      deps.objects.set(String(input.Key), Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(String(input.Body)));
    });

    const result = await processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, env);

    expect(result).toMatchObject({ copied: 0, alreadyArchived: 1, verified: 1, deleted: 0 });
  });

  test('halts on an immutable archive key collision with different content', async () => {
    const item = { deviceId: 'device-a', eventTime: '2026-06-01T12:00:00.000Z' };
    const deps = testDependencies([item]);
    deps.putObject.mockRejectedValue(Object.assign(new Error('Precondition failed'), { $metadata: { httpStatusCode: 412 } }));
    deps.getObject.mockResolvedValue(Buffer.from('different existing object'));

    await expect(processArchivePage({
      action: 'PROCESS_PAGE',
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
      pageNumber: 0,
    }, deps, env)).rejects.toThrow('Archive manifest collision');
    expect(deps.deleteItem).not.toHaveBeenCalled();
  });
});