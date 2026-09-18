import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { processArchivePage } from '../archive';
import * as coordination from '../archive-coordination';
import { handler } from '../archive-control';

// archive-control.ts is now thin dispatch only -- lock ownership, fencing, and failure
// reconciliation all live in archive-coordination.ts and are unit-tested there
// (archive-coordination.test.ts's 24+ tests, including all crash-window/concurrency
// cases). These tests mock that module's exported functions and assert only that this
// file calls the right one, with the right arguments, at the right point in the flow --
// not that the underlying coordination logic is correct, which is a different file's job.

jest.mock('../archive', () => ({
  ...jest.requireActual('../archive'),
  processArchivePage: jest.fn(),
}));

jest.mock('../archive-coordination', () => ({
  ...jest.requireActual('../archive-coordination'),
  acquireLock: jest.fn(),
  assertLockHeld: jest.fn(),
  releaseLock: jest.fn(),
  reconcileFailure: jest.fn(),
  // Only `updateItem` is faked -- archive-control.ts calls it directly (for the RUN item's
  // terminal-status write); everything else on `dependencies` is unused by this file
  // (acquireLock/assertLockHeld/releaseLock/reconcileFailure, which would otherwise use it,
  // are themselves mocked above). Faking it here, rather than letting the real
  // DynamoDBDocumentClient run, keeps this file's tests from attempting a real AWS call.
  dependencies: { updateItem: jest.fn() },
}));

const mockProcessArchivePage = processArchivePage as jest.MockedFunction<typeof processArchivePage>;
const mockAcquireLock = coordination.acquireLock as jest.MockedFunction<typeof coordination.acquireLock>;
const mockAssertLockHeld = coordination.assertLockHeld as jest.MockedFunction<typeof coordination.assertLockHeld>;
const mockReleaseLock = coordination.releaseLock as jest.MockedFunction<typeof coordination.releaseLock>;
const mockReconcileFailure = coordination.reconcileFailure as jest.MockedFunction<typeof coordination.reconcileFailure>;
const mockCoordinationUpdateItem = coordination.dependencies.updateItem as jest.MockedFunction<typeof coordination.dependencies.updateItem>;
const mockS3Send = jest.spyOn(S3Client.prototype, 'send');
const mockDynamoSend = jest.spyOn(DynamoDBClient.prototype, 'send');
const mockCloudWatchSend = jest.spyOn(CloudWatchClient.prototype, 'send');

const EXECUTION_ARN = 'arn:aws:states:us-east-1:123456789012:execution:archive:exec-a';
const COORDINATION_TABLE = 'ArchiveCoordination';

function pageResultFixture(overrides: Partial<Awaited<ReturnType<typeof processArchivePage>>> = {}) {
  return {
    action: 'PROCESS_PAGE' as const,
    runId: '2026-09-01T00-00-00Z',
    cutoff: '2026-07-04T00:00:00.000Z',
    pageNumber: 0,
    nextPageNumber: 1,
    lastEvaluatedKey: undefined,
    complete: true,
    examined: 1,
    eligible: 1,
    copied: 1,
    alreadyArchived: 0,
    verified: 1,
    deleted: 0,
    retained: 0,
    logicalBytes: 100,
    compressedBytes: 80,
    retryCount: 0,
    shardReports: ['manifest.json'],
    failures: [],
    ...overrides,
  };
}

describe('archive control handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOG_EVENTS_TABLE_NAME = 'log-events';
    process.env.RAW_LOGS_BUCKET_NAME = 'archive-bucket';
    process.env.ARCHIVE_COORDINATION_TABLE_NAME = COORDINATION_TABLE;
    process.env.ARCHIVE_DELETE_ENABLED = 'false';
    process.env.ARCHIVE_NOTIFICATION_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:archive';
    mockDynamoSend.mockImplementation(async command => {
      if (command instanceof DescribeTableCommand) {
        return {
          Table: {
            KeySchema: [
              { AttributeName: 'deviceId', KeyType: 'HASH' },
              { AttributeName: 'eventTime', KeyType: 'RANGE' },
            ],
          },
        } as never;
      }
      return {} as never;
    });
    mockS3Send.mockImplementation(async command => {
      if (command instanceof ListObjectsV2Command) return { Contents: [] } as never;
      return {} as never;
    });
    mockCloudWatchSend.mockResolvedValue({} as never);
    mockCoordinationUpdateItem.mockResolvedValue(undefined);
  });

  test('START confirms the source table schema, calls acquireLock, and returns the fencing token', async () => {
    mockAcquireLock.mockResolvedValue({ fencingToken: 7 });

    const result = await handler({
      action: 'START',
      executionStartedAt: '2026-09-01T00:00:00.000Z',
      executionArn: EXECUTION_ARN,
    });

    expect(mockAcquireLock).toHaveBeenCalledWith(
      expect.anything(),
      COORDINATION_TABLE,
      expect.objectContaining({ executionArn: EXECUTION_ARN, sourceTableName: 'log-events', runId: '2026-09-01T00-00-00Z' })
    );
    expect(result).toMatchObject({ action: 'PROCESS_PAGE', runId: '2026-09-01T00-00-00Z', fencingToken: 7 });
  });

  test('START refuses an unexpected source table schema before ever calling acquireLock', async () => {
    mockDynamoSend.mockResolvedValue({ Table: { KeySchema: [{ AttributeName: 'wrong', KeyType: 'HASH' }] } } as never);

    await expect(handler({
      action: 'START', executionStartedAt: '2026-09-01T00:00:00.000Z', executionArn: EXECUTION_ARN,
    })).rejects.toThrow('Refusing to archive unexpected table schema');
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  test('PROCESS_PAGE calls assertLockHeld before processArchivePage, and a fencing mismatch aborts before any scan work', async () => {
    mockAssertLockHeld.mockRejectedValue(new Error('fencing mismatch'));

    await expect(handler({
      action: 'PROCESS_PAGE', runId: 'r', cutoff: 'c', pageNumber: 0,
      executionArn: EXECUTION_ARN, fencingToken: 1,
    } as never)).rejects.toThrow('fencing mismatch');

    expect(mockAssertLockHeld).toHaveBeenCalledWith(expect.anything(), COORDINATION_TABLE, EXECUTION_ARN, 1);
    expect(mockProcessArchivePage).not.toHaveBeenCalled();
  });

  test('records a successful final page when lastEvaluatedKey is undefined, and echoes the fencing token', async () => {
    mockAssertLockHeld.mockResolvedValue(undefined);
    mockProcessArchivePage.mockResolvedValue(pageResultFixture());

    const result = await handler({
      action: 'PROCESS_PAGE', runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z', pageNumber: 0,
      executionArn: EXECUTION_ARN, fencingToken: 3,
    } as never);

    expect(result).toMatchObject({ complete: true, verified: 1, fencingToken: 3 });
    const reportWrite = mockS3Send.mock.calls
      .map(([command]) => command)
      .find(command => command instanceof PutObjectCommand) as PutObjectCommand;
    const report = JSON.parse(String(reportWrite.input.Body));
    expect(report).not.toHaveProperty('lastEvaluatedKey');
    expect(report).toMatchObject({ complete: true, verified: 1 });
  });

  test('FINALIZE calls assertLockHeld then releaseLock with the exact fencing token, and writes a terminal status back to the RUN item', async () => {
    mockAssertLockHeld.mockResolvedValue(undefined);
    mockReleaseLock.mockResolvedValue({ released: true });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({
      action: 'FINALIZE', runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z',
      executionArn: EXECUTION_ARN, fencingToken: 9,
    });

    expect(mockAssertLockHeld).toHaveBeenCalledWith(expect.anything(), COORDINATION_TABLE, EXECUTION_ARN, 9);
    expect(mockReleaseLock).toHaveBeenCalledWith(expect.anything(), COORDINATION_TABLE, EXECUTION_ARN, 9);
    expect(result.status).toBe('SUCCEEDED');
    // Confirms the CloudWatch mock is actually exercised (not merely silencing a real
    // network call to a real account) and that a real run publishes RunCompleted.
    const metricCall = mockCloudWatchSend.mock.calls
      .map(([command]) => command)
      .find(command => command instanceof PutMetricDataCommand) as PutMetricDataCommand;
    expect(metricCall.input.MetricData).toEqual(expect.arrayContaining([
      expect.objectContaining({ MetricName: 'RunCompleted', Value: 1 }),
    ]));
    // The RUN item's own `status` must actually be written to SUCCEEDED, not just the
    // S3 report/SNS message -- prior to this fix nothing ever touched the RUN item again
    // after acquireLock created it as STARTED, even on a clean success.
    expect(mockCoordinationUpdateItem).toHaveBeenCalledWith(expect.objectContaining({
      TableName: COORDINATION_TABLE,
      Key: coordination.runItemKey(EXECUTION_ARN),
      ExpressionAttributeValues: expect.objectContaining({ ':status': 'SUCCEEDED' }),
    }));
    // The releaseLock-visibility fix must be a no-op on this already-proven-correct
    // success path: released:true here, so nothing should be logged.
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('FINALIZE logs explicitly when releaseLock reports released:false, without changing the reported outcome', async () => {
    mockAssertLockHeld.mockResolvedValue(undefined);
    mockReleaseLock.mockResolvedValue({ released: false, reason: 'lock-not-held' });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({
      action: 'FINALIZE', runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z',
      executionArn: EXECUTION_ARN, fencingToken: 9,
    });

    // Silently swallowed before this fix: the run is still reported the same way (this
    // fix only adds visibility, it must not change what a caller/Step Functions sees).
    expect(result.status).toBe('SUCCEEDED');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('archive_run_lock_not_released'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('lock-not-held'));
  });

  test('FINALIZE does not release the lock if assertLockHeld rejects', async () => {
    mockAssertLockHeld.mockRejectedValue(new Error('fencing mismatch'));

    await expect(handler({
      action: 'FINALIZE', runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z',
      executionArn: EXECUTION_ARN, fencingToken: 9,
    })).rejects.toThrow('fencing mismatch');
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockCoordinationUpdateItem).not.toHaveBeenCalled();
  });

  test('RECONCILE_FAILURE from the in-workflow Catch path normalizes the ASL {Error,Cause} payload into a real Error with cause', async () => {
    mockReconcileFailure.mockResolvedValue({ outcome: 'REPORTED', lockReleased: true, notificationPublished: true });

    const before = Date.now();
    const result = await handler({
      action: 'RECONCILE_FAILURE',
      executionArn: EXECUTION_ARN,
      context: { runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z' },
      // This is the actual shape Step Functions' Catch puts at $.failure -- a plain
      // object with string Error/Cause fields, never a real Error instance. Using
      // `new Error('boom')` here (as an earlier version of this test did) would pass
      // even if normalizeCatchError were deleted entirely, since a real Error is already
      // `instanceof Error` and needs no normalization -- it would never have caught the
      // "[object Object]"/lost-cause bug this test exists to guard.
      error: { Error: 'States.TaskFailed', Cause: 'Lambda threw: table unreachable' },
    });
    const after = Date.now();

    expect(mockReconcileFailure).toHaveBeenCalledTimes(1);
    const [, callArgs] = mockReconcileFailure.mock.calls[0];
    expect(callArgs).toMatchObject({
      tableName: COORDINATION_TABLE,
      executionArn: EXECUTION_ARN,
      runId: '2026-09-01T00-00-00Z',
      cutoff: '2026-07-04T00:00:00.000Z',
    });
    expect(callArgs.error).toBeInstanceOf(Error);
    expect((callArgs.error as Error).message).toBe('States.TaskFailed');
    expect((callArgs.error as Error & { cause?: unknown }).cause).toBe('Lambda threw: table unreachable');
    expect(callArgs.now).toBeGreaterThanOrEqual(before);
    expect(callArgs.now).toBeLessThanOrEqual(after);
    expect(result).toMatchObject({ outcome: 'REPORTED' });
  });

  test('RECONCILE_FAILURE throws on REPORT_CONFLICT so the failure is operator-visible, not silently absorbed', async () => {
    mockReconcileFailure.mockResolvedValue({ outcome: 'REPORT_CONFLICT', reportKey: 'a/b/c.failed.json', lockReleased: false, notificationPublished: false });

    await expect(handler({
      action: 'RECONCILE_FAILURE',
      executionArn: EXECUTION_ARN,
      context: { runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z' },
      error: { Error: 'States.TaskFailed', Cause: 'boom' },
    })).rejects.toThrow(/REPORT_CONFLICT|conflict/i);
  });

  test('RECONCILE_FAILURE returns normally (does not throw) on CLAIM_HELD_ELSEWHERE, since both failure paths racing is the expected common case', async () => {
    mockReconcileFailure.mockResolvedValue({ outcome: 'CLAIM_HELD_ELSEWHERE', lockReleased: false, notificationPublished: false });

    const result = await handler({
      action: 'RECONCILE_FAILURE',
      executionArn: EXECUTION_ARN,
      context: { runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-04T00:00:00.000Z' },
      error: { Error: 'States.TaskFailed', Cause: 'boom' },
    });

    expect(result).toMatchObject({ outcome: 'CLAIM_HELD_ELSEWHERE' });
  });

  test('RECONCILE_FAILURE from the EventBridge path assembles executionStartedAt/status, with no runId/cutoff/error available', async () => {
    mockReconcileFailure.mockResolvedValue({ outcome: 'REPORTED', lockReleased: false, notificationPublished: true });
    const executionStartedAt = Date.parse('2026-09-01T00:00:00.000Z');

    await handler({
      action: 'RECONCILE_FAILURE',
      executionArn: EXECUTION_ARN,
      executionStartedAt,
      status: 'TIMED_OUT',
    });

    expect(mockReconcileFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tableName: COORDINATION_TABLE,
      executionArn: EXECUTION_ARN,
      status: 'TIMED_OUT',
      now: executionStartedAt,
      runId: undefined,
      cutoff: undefined,
      error: undefined,
    }));
  });
});
