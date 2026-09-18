import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  CoordinationDependencies,
  TransactItem,
  LockHeldError,
  LockFencingError,
  ReportConflictError,
  CLAIM_LEASE_MINUTES,
  COORDINATION_LOCK_PK,
  COORDINATION_SK,
  acquireLock,
  assertLockHeld,
  releaseLock,
  reconcileFailure,
  runItemKey,
  reportKeyFor,
} from '../archive-coordination';

// --- A genuinely atomic fake DynamoDB table --------------------------------------------
// This is not a mock that always succeeds: it parses and evaluates the actual
// ConditionExpression string sent by production code against the actual stored state, so
// a bug in the real conditional-write logic (wrong operator, wrong field, a missing AND
// clause) would make these tests fail for the right reason, not silently pass. See
// STYLE_GUIDE.md Sec.5: "a mock that cannot fail... is not a passing test, it's a missing
// one." transactWrite evaluates every item's condition against current state BEFORE
// applying any mutation, matching DynamoDB's real all-or-nothing transaction semantics.

class ConditionalCheckFailedException extends Error { name = 'ConditionalCheckFailedException'; }
class TransactionCanceledException extends Error { name = 'TransactionCanceledException'; }

// Matches baseInput()'s default `now` below -- the fake's clock and the invocation-start
// timestamp start in sync; a test only needs to touch `table.clock` explicitly when it's
// specifically simulating elapsed real time between two calls (a paused/resumed caller, or
// a second caller arriving after a lease expiry).
const DEFAULT_CLOCK = Date.parse('2026-09-01T02:00:00.000Z');

type Row = Record<string, unknown>;

function keyOf(key: Row): string {
  return `${key.PK}#${key.SK}`;
}

function evaluateCondition(
  expression: string | undefined,
  item: Row | undefined,
  values: Record<string, unknown>,
  names: Record<string, string>
): boolean {
  if (!expression) return true;
  return new ConditionParser(expression, item, values, names).parseOr();
}

// Supports dotted nested-attribute paths (e.g. `notification.#state`), which real
// DynamoDB ConditionExpressions allow for map attributes and which claimAndPublishNotification
// actually uses. An earlier version of this parser didn't handle dots at all, which is a
// fixture limitation (not a production bug) worth fixing properly rather than avoiding the
// syntax in application code to work around a test double's gap.
class ConditionParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(expr: string, private item: Row | undefined, private values: Record<string, unknown>, private names: Record<string, string>) {
    this.tokens = expr.match(/\(|\)|[A-Za-z_#][A-Za-z0-9_.#]*|:[A-Za-z0-9_]+|=|<|,/g) || [];
  }
  private peek(): string | undefined { return this.tokens[this.pos]; }
  private next(): string { return this.tokens[this.pos++]; }
  parseOr(): boolean {
    let result = this.parseAnd();
    while (this.peek() === 'OR') { this.next(); result = this.parseAnd() || result; }
    return result;
  }
  private parseAnd(): boolean {
    let result = this.parseTerm();
    while (this.peek() === 'AND') { this.next(); result = this.parseTerm() && result; }
    return result;
  }
  private parseTerm(): boolean {
    if (this.peek() === '(') {
      this.next();
      const result = this.parseOr();
      this.next(); // ')'
      return result;
    }
    if (this.peek() === 'attribute_not_exists') {
      this.next(); this.next(); // 'attribute_not_exists' '('
      const path = this.resolvePath(this.next());
      this.next(); // ')'
      return !this.hasPath(this.item, path);
    }
    const path = this.resolvePath(this.next());
    const op = this.next();
    const valueToken = this.next();
    const expected = this.values[valueToken];
    const actual = this.getPath(this.item, path);
    if (op === '=') return actual === expected;
    if (op === '<') return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    throw new Error(`Unsupported operator in fake condition evaluator: ${op}`);
  }
  private resolvePath(token: string): string[] {
    return token.split('.').map(segment => (segment.startsWith('#') ? this.names[segment] : segment));
  }
  private getPath(item: Row | undefined, path: string[]): unknown {
    let current: unknown = item;
    for (const segment of path) {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Row)[segment];
    }
    return current;
  }
  private hasPath(item: Row | undefined, path: string[]): boolean {
    let current: unknown = item;
    for (const segment of path) {
      if (current === null || typeof current !== 'object' || !(segment in (current as Row))) return false;
      current = (current as Row)[segment];
    }
    return true;
  }
}

// Minimal SET-only UpdateExpression applier, matching the small grammar this module emits:
// "SET a = :x, b = :y, #c = :z"
function applyUpdate(current: Row | undefined, key: Row, expression: string, values: Record<string, unknown>, names: Record<string, string>): Row {
  const next: Row = { ...key, ...current };
  const assignments = expression.replace(/^SET\s+/, '').split(',').map(part => part.trim());
  for (const assignment of assignments) {
    const [rawField, rawValue] = assignment.split('=').map(part => part.trim());
    const field = rawField.startsWith('#') ? names[rawField] : rawField;
    if (rawValue.startsWith('if_not_exists(')) {
      const inner = rawValue.slice('if_not_exists('.length, -1);
      const [ifAbsentField, fallbackToken] = inner.split(',').map(part => part.trim());
      const resolvedField = ifAbsentField.startsWith('#') ? names[ifAbsentField] : ifAbsentField;
      next[field] = resolvedField in next ? next[resolvedField] : values[fallbackToken];
      continue;
    }
    if (rawValue.includes('+')) {
      const [leftToken, rightToken] = rawValue.split('+').map(part => part.trim());
      const left = leftToken.startsWith(':') ? values[leftToken] : (next[leftToken.startsWith('#') ? names[leftToken] : leftToken] ?? 0);
      const right = values[rightToken];
      next[field] = (left as number) + (right as number);
      continue;
    }
    next[field] = values[rawValue];
  }
  return next;
}

// Round-trips a value through the REAL DynamoDB marshaller/unmarshaller (wrapped in a
// throwaway map, since marshall operates on a whole item). This replaces an earlier
// hand-rolled "reject nested undefined" check: Codex found that check missed sparse array
// holes (`[, 'detail']`), which the real SDK silently densifies on marshal rather than
// rejecting -- a divergence a hand-written approximation could keep re-missing in new
// forms. Using the actual SDK closes that whole class at once: whatever the real client
// would throw on, reject, or transform, this does too, because it IS the real client.
function sdkRoundTrip<T>(value: T): T {
  return (unmarshall(marshall({ v: value })) as { v: T }).v;
}

class FakeCoordinationTable implements CoordinationDependencies {
  private rows = new Map<string, Row>();
  putObjectCalls: Array<{ Key: string; IfNoneMatch?: string }> = [];
  objects = new Map<string, Buffer>();
  publishCalls: Array<{ TopicArn: string; Subject: string; Message: string }> = [];
  describeExecutionResult: { status?: string; startDate?: Date; stopDate?: Date; error?: string; cause?: string } | undefined = { status: 'FAILED' };
  publishShouldFail = false;
  // Deliberately a separate, explicitly-settable field, not derived from whatever `now`
  // value a test last passed to reconcileFailure -- the whole point of the production
  // now() split (Codex's fourth-pass review) is that those two can genuinely diverge within
  // one invocation. The `reconcile()` helper below keeps them in sync for tests that don't
  // care about that distinction; tests that DO care (the ones simulating elapsed real time
  // between a paused caller and a resumed one) set `table.clock` explicitly.
  clock = DEFAULT_CLOCK;

  now(): number { return this.clock; }

  snapshot(key: Row): Row | undefined {
    const row = this.rows.get(keyOf(key));
    return row ? { ...row } : undefined;
  }

  async getItem({ Key }: { Key: Row }) { return this.snapshot(Key); }

  async putItem({ Item, ConditionExpression }: { Item: Row; ConditionExpression?: string }) {
    const item = sdkRoundTrip(Item);
    const current = this.rows.get(keyOf(item));
    if (!evaluateCondition(ConditionExpression, current, {}, {})) throw new ConditionalCheckFailedException();
    this.rows.set(keyOf(item), item);
  }

  async updateItem(params: { TableName: string; Key: Row; UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> }) {
    const values = sdkRoundTrip(params.ExpressionAttributeValues);
    const current = this.rows.get(keyOf(params.Key));
    if (!evaluateCondition(params.ConditionExpression, current, values, params.ExpressionAttributeNames || {})) {
      throw new ConditionalCheckFailedException();
    }
    this.rows.set(keyOf(params.Key), applyUpdate(current, params.Key, params.UpdateExpression, values, params.ExpressionAttributeNames || {}));
  }

  async transactWrite({ items }: { TableName: string; items: TransactItem[] }) {
    const roundTripped = items.map(item => ({
      put: item.put ? { ...item.put, Item: sdkRoundTrip(item.put.Item) } : undefined,
      update: item.update ? { ...item.update, ExpressionAttributeValues: sdkRoundTrip(item.update.ExpressionAttributeValues) } : undefined,
    }));
    for (const item of roundTripped) {
      if (item.update) {
        const current = this.rows.get(keyOf(item.update.Key));
        if (!evaluateCondition(item.update.ConditionExpression, current, item.update.ExpressionAttributeValues, item.update.ExpressionAttributeNames || {})) {
          throw new TransactionCanceledException();
        }
      } else if (item.put) {
        const current = this.rows.get(keyOf(item.put.Item));
        if (!evaluateCondition(item.put.ConditionExpression, current, {}, {})) throw new TransactionCanceledException();
      }
    }
    for (const item of roundTripped) {
      if (item.update) {
        const current = this.rows.get(keyOf(item.update.Key));
        this.rows.set(keyOf(item.update.Key), applyUpdate(current, item.update.Key, item.update.UpdateExpression, item.update.ExpressionAttributeValues, item.update.ExpressionAttributeNames || {}));
      } else if (item.put) {
        this.rows.set(keyOf(item.put.Item), item.put.Item);
      }
    }
  }

  async putObject({ Key, Body, IfNoneMatch }: { Bucket: string; Key: string; Body: Buffer; ContentType: string; IfNoneMatch?: string }) {
    this.putObjectCalls.push({ Key, IfNoneMatch });
    if (IfNoneMatch === '*' && this.objects.has(Key)) {
      const error = new Error('PreconditionFailed') as Error & { $metadata: { httpStatusCode: number } };
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    this.objects.set(Key, Buffer.from(Body));
  }

  async getObject({ Key }: { Bucket: string; Key: string }) {
    const body = this.objects.get(Key);
    if (!body) throw new Error(`No such object: ${Key}`);
    return body;
  }

  async publish(params: { TopicArn: string; Subject: string; Message: string }) {
    this.publishCalls.push(params);
    if (this.publishShouldFail) throw new Error('SNS unavailable');
    return { messageId: 'msg-1' };
  }

  async describeExecution() { return this.describeExecutionResult; }
}

function baseInput(overrides: Partial<{ executionArn: string; runId: string; cutoff: string; sourceTableName: string; now: number }> = {}) {
  return {
    executionArn: 'arn:aws:states:us-east-1:123456789012:execution:archive:exec-a',
    runId: '2026-09-01T00-00-00Z',
    cutoff: '2026-07-03T00:00:00.000Z',
    sourceTableName: 'log-events',
    now: Date.parse('2026-09-01T02:00:00.000Z'),
    ...overrides,
  };
}

const TABLE = 'ArchiveCoordination';
const BUCKET = 'archive-bucket';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:archive-topic';

// Syncs the fake's clock to `args.now` before calling reconcileFailure, so claim/lease
// computations inside claimReporting/claimAndPublishNotification (which read deps.now(),
// not args.now) see the same "current time" the test intends for that call, unless the
// test has deliberately diverged the two (by setting table.clock itself beforehand) to
// simulate elapsed real time within a still-in-flight invocation.
function reconcile(table: FakeCoordinationTable, args: Parameters<typeof reconcileFailure>[1]): ReturnType<typeof reconcileFailure> {
  table.clock = args.now;
  return reconcileFailure(table, args);
}

// --- Lock primitives --------------------------------------------------------------------

test('acquireLock creates the lock and RUN item, and a second acquire is rejected while the lease is active', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const { fencingToken } = await acquireLock(table, TABLE, input);
  expect(fencingToken).toBe(1);

  await expect(acquireLock(table, TABLE, baseInput({ executionArn: 'arn:...:exec-b' })))
    .rejects.toThrow('Historical rewrite lock already held by another execution.');
});

test('acquireLock is idempotent when the same execution retries after already acquiring', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const first = await acquireLock(table, TABLE, input);
  const second = await acquireLock(table, TABLE, input);
  expect(second.fencingToken).toBe(first.fencingToken);
});

test('acquireLock reacquires after the lease has expired, with a strictly increasing fencing token', async () => {
  const table = new FakeCoordinationTable();
  const first = await acquireLock(table, TABLE, baseInput({ now: 1000, executionArn: 'arn:...:exec-a' }));
  const expiredLaterNow = 1000 + 25 * 60 * 60 * 1000; // 25h later, past the 24h lease
  const second = await acquireLock(table, TABLE, baseInput({ now: expiredLaterNow, executionArn: 'arn:...:exec-b' }));
  expect(second.fencingToken).toBe(first.fencingToken + 1);
});

test('the same-second concurrency case: two executions racing acquireLock, only one wins, structurally', async () => {
  const table = new FakeCoordinationTable();
  const now = Date.parse('2026-09-01T00:00:00.900Z');
  const inputA = baseInput({ executionArn: 'arn:...:exec-first', now });
  const inputB = baseInput({ executionArn: 'arn:...:exec-second', now });

  const [resultA, resultB] = await Promise.allSettled([
    acquireLock(table, TABLE, inputA),
    acquireLock(table, TABLE, inputB),
  ]);

  const outcomes = [resultA, resultB];
  const fulfilled = outcomes.filter(r => r.status === 'fulfilled');
  const rejected = outcomes.filter(r => r.status === 'rejected');
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LockHeldError);

  // The loser's RUN item must never have been created (the whole transaction rolled back).
  const winnerArn = resultA.status === 'fulfilled' ? inputA.executionArn : inputB.executionArn;
  const loserArn = winnerArn === inputA.executionArn ? inputB.executionArn : inputA.executionArn;
  expect(table.snapshot(runItemKey(loserArn))).toBeUndefined();
  const winnerRun = table.snapshot(runItemKey(winnerArn));
  expect(winnerRun).toBeDefined();

  // The loser's failure cleanup must not touch the winner's lock: absence of lockFencingToken
  // on the loser's RUN item is what reconcileFailure uses to skip the release entirely.
  const loserResult = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: loserArn, status: 'FAILED', error: new Error('lock not held'), now,
  });
  expect(loserResult.lockReleased).toBe(false);
  const lockAfter = table.snapshot({ PK: 'LOCK#monthly-archive', SK: 'METADATA' });
  expect(lockAfter?.ownerExecutionArn).toBe(winnerArn);
});

test('assertLockHeld rejects on absent lock, owner mismatch, and token mismatch', async () => {
  const table = new FakeCoordinationTable();
  await expect(assertLockHeld(table, TABLE, 'arn:...:x', 1)).rejects.toBeInstanceOf(LockFencingError);

  const input = baseInput();
  const { fencingToken } = await acquireLock(table, TABLE, input);
  await expect(assertLockHeld(table, TABLE, 'arn:...:other', fencingToken)).rejects.toBeInstanceOf(LockFencingError);
  await expect(assertLockHeld(table, TABLE, input.executionArn, fencingToken + 1)).rejects.toBeInstanceOf(LockFencingError);
  await expect(assertLockHeld(table, TABLE, input.executionArn, fencingToken)).resolves.toBeUndefined();
});

// releaseLock clears ownership via a conditional Update, not a Delete -- deleting the item
// would delete the fencing counter with it, which is exactly the ABA hole Codex found (see
// the UNOWNED comment in archive-coordination.ts). The item, and its counter, persist
// forever; only ownerExecutionArn/leaseExpiry reset.
test('releaseLock clears ownership only on an exact owner+token match, preserving the fencing counter, with no read preceding the write', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const { fencingToken } = await acquireLock(table, TABLE, input);

  const getItemSpy = jest.spyOn(table, 'getItem');
  const mismatch = await releaseLock(table, TABLE, 'arn:...:other', fencingToken);
  expect(mismatch).toEqual({ released: false, reason: 'lock-not-held' });
  expect(getItemSpy).not.toHaveBeenCalled();

  const released = await releaseLock(table, TABLE, input.executionArn, fencingToken);
  expect(released).toEqual({ released: true });
  const lockAfter = table.snapshot({ PK: 'LOCK#monthly-archive', SK: 'METADATA' });
  expect(lockAfter?.ownerExecutionArn).toBe('');
  expect(lockAfter?.fencingToken).toBe(fencingToken); // preserved, not reset
  expect(getItemSpy).not.toHaveBeenCalled();

  // The next acquisition must continue the sequence, never restart at 1.
  const next = await acquireLock(table, TABLE, baseInput({ executionArn: 'arn:...:exec-next' }));
  expect(next.fencingToken).toBe(fencingToken + 1);
});

// --- reconcileFailure: crash-window cases ------------------------------------------------

test('crash-window (a): a full run against an empty store completes end to end', async () => {
  const table = new FakeCoordinationTable();
  const now = baseInput().now;
  const result = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: 'arn:...:exec-a', runId: '2026-09-01T00-00-00Z', cutoff: '2026-07-03T00:00:00.000Z',
    status: 'FAILED', error: new Error('boom'), now,
  });
  expect(result.outcome).toBe('REPORTED');
  expect(table.objects.has(result.reportKey!)).toBe(true);
  const run = table.snapshot(runItemKey('arn:...:exec-a'));
  expect(run?.reportState).toBe('REPORTED');
});

test('crash-window (b): retry after the S3 write succeeded but before the RUN commit completes idempotently', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  // First call gets all the way to REPORTED normally.
  const first = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    status: 'FAILED', error: new Error('boom'), now: input.now,
  });
  expect(first.outcome).toBe('REPORTED');
  const writesAfterFirst = table.putObjectCalls.filter(c => c.Key === first.reportKey).length;
  expect(writesAfterFirst).toBe(1);

  // Simulate a retry landing after the S3 object exists but pretend reportState regressed to
  // WRITING with an expired claim (the crash point: wrote S3, crashed before the RUN commit).
  const runKey = runItemKey(input.executionArn);
  const stuck = table.snapshot(runKey)!;
  await table.updateItem({
    TableName: TABLE, Key: runKey,
    UpdateExpression: 'SET reportState = :writing, claimToken = :stale, claimExpiry = :expired',
    ExpressionAttributeValues: { ':writing': 'WRITING', ':stale': 'stale-token', ':expired': input.now - 1 },
  });
  void stuck;

  const retry = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    status: 'FAILED', error: new Error('boom'), now: input.now + 1000,
  });
  expect(retry.outcome).toBe('REPORTED');
  // The idempotent-write path (412 + digest match) must not create a second distinct object body,
  // and must not exceed one additional putObject attempt beyond the original write.
  const writesAfterRetry = table.putObjectCalls.filter(c => c.Key === first.reportKey).length;
  expect(writesAfterRetry).toBe(2); // original write + retry's 412-triggering attempt
  expect(table.snapshot(runKey)?.reportState).toBe('REPORTED');
});

// The real step order is report -> commit -> release -> notify, so a crash between commit
// and release necessarily also means notification was never attempted -- unlike an earlier
// version of this test, which pre-seeded notification.attempted:true and so never exercised
// the retry's obligation to resume it. Codex caught that this test's premise didn't match
// the code's actual ordering, and that the retry path had no mechanism to resume a skipped
// notification at all (P2 finding). Both are fixed here together: the test now matches the
// real crash point, and the retry must both release the lock and send the notification.
test('crash-window (c): retry after REPORTED but before lock release/notify resumes both', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const { fencingToken } = await acquireLock(table, TABLE, input);

  const runKey = runItemKey(input.executionArn);
  await table.updateItem({
    TableName: TABLE, Key: runKey,
    UpdateExpression: 'SET reportState = :reported, reportS3Key = :key, lockFencingToken = :token, failureEvidence = :evidence',
    ExpressionAttributeValues: {
      ':reported': 'REPORTED', ':key': 'already/written.json', ':token': fencingToken,
      ':evidence': { source: 'catch', sfnStatus: 'FAILED', error: 'boom' },
    },
  });

  const retry = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', error: new Error('boom'), now: input.now,
  });

  expect(retry.outcome).toBe('REPORTED');
  expect(retry.lockReleased).toBe(true);
  expect(retry.notificationPublished).toBe(true);
  expect(table.snapshot({ PK: 'LOCK#monthly-archive', SK: 'METADATA' })?.ownerExecutionArn).toBe('');
  expect(table.publishCalls.length).toBe(1);
  // Must not re-attempt the S3 write for an already-reported run.
  expect(table.putObjectCalls.some(c => c.Key === 'already/written.json')).toBe(false);
});

test('crash-window (d): a failure before any RUN item exists still creates one and completes', async () => {
  const table = new FakeCoordinationTable();
  const now = baseInput().now;
  expect(table.snapshot(runItemKey('arn:...:exec-a'))).toBeUndefined();

  const result = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: 'arn:...:exec-a', status: 'FAILED', error: new Error('start-phase failure'), now,
  });

  expect(result.outcome).toBe('REPORTED');
  expect(result.lockReleased).toBe(false); // never held a lock in the first place
  const body = JSON.parse(table.objects.get(result.reportKey!)!.toString('utf8'));
  expect(body).toMatchObject({ status: 'FAILED', cutoff: null, runId: null });
  expect(Object.prototype.hasOwnProperty.call(body, 'cutoff')).toBe(true);
});

// --- Competing-path test ------------------------------------------------------------------

test('competing path: in-workflow Catch and EventBridge cleanup racing for the same execution produce exactly one report', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  const reconcileArgs = {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff, now: input.now,
  };

  const [fromCatch, fromEventBridge] = await Promise.allSettled([
    reconcile(table, { ...reconcileArgs, error: new Error('caught in workflow') }),
    reconcile(table, { ...reconcileArgs, status: 'FAILED' }),
  ]);

  const results = [fromCatch, fromEventBridge].filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof reconcileFailure>>> => r.status === 'fulfilled').map(r => r.value);
  const reported = results.filter(r => r.outcome === 'REPORTED');
  const heldElsewhere = results.filter(r => r.outcome === 'CLAIM_HELD_ELSEWHERE');

  expect(reported.length).toBe(1);
  expect(heldElsewhere.length).toBe(1);
  expect(table.putObjectCalls.filter(c => c.IfNoneMatch === '*' && c.Key === reported[0].reportKey).length).toBe(1);
  const run = table.snapshot(runItemKey(input.executionArn));
  expect(run?.reportState).toBe('REPORTED');
});

// --- Digest-conflict path ------------------------------------------------------------------

test('a report key collision with different content is a ReportConflict, never an overwrite', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const key = reportKeyFor(input.executionArn, input.now);
  await table.putObject({ Bucket: BUCKET, Key: key, Body: Buffer.from('{"someone":"else wrote this"}'), ContentType: 'application/json' });

  const result = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    status: 'FAILED', error: new Error('boom'), now: input.now,
  });

  expect(result.outcome).toBe('REPORT_CONFLICT');
  expect(table.objects.get(key)!.toString('utf8')).toBe('{"someone":"else wrote this"}');
  const run = table.snapshot(runItemKey(input.executionArn));
  expect(run?.reportConflict).toBe(true);
  expect(run?.reportState).toBe('WRITING');
});

test('sticky-conflict fix: a retry within the same claim window also reports REPORT_CONFLICT, not a false CLAIM_HELD_ELSEWHERE success', async () => {
  // recordReportConflict sets reportConflict=true but deliberately leaves reportState as
  // WRITING (the claim itself is not released or reset). Before this fix, that meant every
  // OTHER caller arriving before the ~5-minute claim lease expired -- the dual-fire
  // in-workflow Catch + EventBridge invocation this system always produces, or a Lambda
  // async-invoke's own automatic retry -- would hit claimReporting's fallback path, see an
  // active (non-expired) claim, and return plain CLAIM_HELD_ELSEWHERE: indistinguishable
  // from an ordinary in-flight race, and treated as success by the caller. That silently
  // swallowed a genuine, already-detected conflict. Reproduces Codex's exact scenario: a
  // second call ~60 seconds after the first.
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const key = reportKeyFor(input.executionArn, input.now);
  await table.putObject({ Bucket: BUCKET, Key: key, Body: Buffer.from('{"someone":"else wrote this"}'), ContentType: 'application/json' });

  const first = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    status: 'FAILED', error: new Error('boom'), now: input.now,
  });
  expect(first.outcome).toBe('REPORT_CONFLICT');

  const second = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    status: 'FAILED', error: new Error('boom'), now: input.now + 60_000,
  });
  expect(second.outcome).toBe('REPORT_CONFLICT');
  expect(second.outcome).not.toBe('CLAIM_HELD_ELSEWHERE');
});

// --- Notification ordering ------------------------------------------------------------------

test('an SNS publish failure does not block or unwind the already-committed report and lock release', async () => {
  const table = new FakeCoordinationTable();
  table.publishShouldFail = true;
  const input = baseInput();
  const { fencingToken } = await acquireLock(table, TABLE, input);
  void fencingToken;

  await expect(reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    status: 'FAILED', error: new Error('boom'), now: input.now,
  })).rejects.toThrow('SNS unavailable');

  const run = table.snapshot(runItemKey(input.executionArn));
  expect(run?.reportState).toBe('REPORTED');
  expect(table.snapshot({ PK: 'LOCK#monthly-archive', SK: 'METADATA' })?.ownerExecutionArn).toBe('');
});

// --- Regression tests for the four issues Codex found in the first review pass ----------
// Each of these names the specific attack Codex reproduced, so a future change that
// reintroduces any of these can't slip past silently the way the originals did.

test('ABA fix: fencing tokens never repeat, so a stale reader of an earlier unowned state cannot hijack a later acquisition', async () => {
  const table = new FakeCoordinationTable();
  const now = baseInput().now;

  const first = await acquireLock(table, TABLE, baseInput({ executionArn: 'arn:...:exec-a', now }));
  await releaseLock(table, TABLE, 'arn:...:exec-a', first.fencingToken);

  // A stale contender reads this unowned state (token = first.fencingToken), then pauses --
  // simulating a slow or retried Lambda invocation mid-flight.
  let resumeStale: () => void;
  const gate = new Promise<void>(resolve => { resumeStale = resolve; });
  const realGetItem = table.getItem.bind(table);
  let intercepted = false;
  table.getItem = async params => {
    const result = await realGetItem(params);
    if (!intercepted && (params as { Key: Row }).Key.PK === COORDINATION_LOCK_PK) {
      intercepted = true;
      await gate;
    }
    return result;
  };
  const staleAttempt = acquireLock(table, TABLE, baseInput({ executionArn: 'arn:...:stale', now: now + 1 }));
  await new Promise(resolve => setImmediate(resolve));
  table.getItem = realGetItem;

  // Two full, legitimate acquire/release cycles happen while the stale reader is paused.
  const second = await acquireLock(table, TABLE, baseInput({ executionArn: 'arn:...:exec-b', now: now + 2 }));
  await releaseLock(table, TABLE, 'arn:...:exec-b', second.fencingToken);
  const third = await acquireLock(table, TABLE, baseInput({ executionArn: 'arn:...:exec-c', now: now + 3 }));

  resumeStale!();
  await expect(staleAttempt).rejects.toBeInstanceOf(LockHeldError);

  const lockAfter = table.snapshot({ PK: COORDINATION_LOCK_PK, SK: COORDINATION_SK });
  expect(lockAfter?.ownerExecutionArn).toBe('arn:...:exec-c');
  expect(lockAfter?.fencingToken).toBe(third.fencingToken);
  expect(third.fencingToken).toBeGreaterThan(first.fencingToken);
});

test('frozen evidence fix: a crash-then-retry from the OTHER entry point does not produce a false REPORT_CONFLICT', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  // The in-workflow Catch path wins evidence-freeze and the claim, writes S3 successfully,
  // then crashes before committing REPORTED.
  const realUpdateItem = table.updateItem.bind(table);
  let crashOnce = true;
  table.updateItem = async params => {
    if (crashOnce && params.UpdateExpression.includes('reportedAt')) { crashOnce = false; throw new Error('crash before commit'); }
    return realUpdateItem(params);
  };
  await expect(reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: new Error('caught in workflow'), now: input.now,
  })).rejects.toThrow('crash before commit');
  table.updateItem = realUpdateItem;

  // The retry comes from the OTHER entry point: no `error` (EventBridge path), a different
  // `status`. If evidence/status weren't frozen together on first write, this would compute
  // different report bytes than what's already in S3 and permanently fail as REPORT_CONFLICT.
  // now must be past the claim lease, or claimReporting correctly refuses to take over an
  // an active (unexpired) claim -- that's the intended behavior, not the bug this test targets.
  const retry = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'TIMED_OUT', now: input.now + CLAIM_LEASE_MINUTES * 60 * 1000 + 1000,
  });
  expect(retry.outcome).toBe('REPORTED');
  expect(retry.lockReleased).toBe(true);
});

test('frozen report-key fix: a retry across a month boundary reuses the original key instead of forking a second object', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput({ now: Date.parse('2026-09-30T23:59:00.000Z') });
  await acquireLock(table, TABLE, input);

  const realUpdateItem = table.updateItem.bind(table);
  let crashOnce = true;
  table.updateItem = async params => {
    if (crashOnce && params.UpdateExpression.includes('reportedAt')) { crashOnce = false; throw new Error('crash before commit'); }
    return realUpdateItem(params);
  };
  await expect(reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: new Error('boom'), now: input.now,
  })).rejects.toThrow('crash before commit');
  table.updateItem = realUpdateItem;

  const retry = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: Date.parse('2026-10-01T00:05:00.000Z'),
  });

  expect(retry.reportKey).toContain('/2026/09/'); // the ORIGINAL month, not October
  expect(table.objects.size).toBe(1); // no second object under a new month prefix
});

test('superseded-claimant fix: a claimant whose claim expired before it could commit does not publish a second notification', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);
  const args = { tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC, executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff, status: 'FAILED' };

  // Writer A claims, writes S3, then pauses right before its own commit.
  let resumeA: () => void;
  const gate = new Promise<void>(resolve => { resumeA = resolve; });
  const realUpdateItem = table.updateItem.bind(table);
  let paused = false;
  table.updateItem = async params => {
    if (!paused && params.UpdateExpression.includes('reportedAt')) { paused = true; await gate; }
    return realUpdateItem(params);
  };
  const writerA = reconcile(table, { ...args, error: new Error('boom'), now: input.now });

  // While A is paused, its claim lease expires; writer B reclaims and finishes entirely.
  await new Promise(resolve => setImmediate(resolve));
  table.updateItem = realUpdateItem;
  const pastClaimExpiry = input.now + CLAIM_LEASE_MINUTES * 60 * 1000 + 1000;
  const writerB = await reconcile(table, { ...args, now: pastClaimExpiry });
  expect(writerB.outcome).toBe('REPORTED');
  expect(table.publishCalls.length).toBe(1);

  resumeA!();
  const resultA = await writerA;
  expect(resultA.outcome).toBe('REPORTED');
  expect(resultA.lockReleased).toBe(false); // B already released it
  // notificationPublished reports "a notification exists for this run" (true, sent by B),
  // not "I personally sent it" -- the invariant that actually matters is no duplicate send.
  expect(resultA.notificationPublished).toBe(true);
  expect(table.publishCalls.length).toBe(1); // still exactly one publish, not two
});

test('resume-on-supersession fix: a superseded caller finishes an unfinished tail if the winner itself crashed before completing it', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);
  const args = { tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC, executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff, status: 'FAILED' };

  // Writer A claims, writes S3, pauses right before its own commit.
  let resumeA: () => void;
  const gate = new Promise<void>(resolve => { resumeA = resolve; });
  const realUpdateItem = table.updateItem.bind(table);
  let paused = false;
  table.updateItem = async params => {
    if (!paused && params.UpdateExpression.includes('reportedAt')) { paused = true; await gate; }
    return realUpdateItem(params);
  };
  const writerA = reconcile(table, { ...args, error: new Error('boom'), now: input.now });

  // B reclaims after A's claim expires, commits successfully, but ITSELF crashes before
  // release/notify (the gap the original fix didn't close: A gave up unconditionally on
  // seeing itself superseded, assuming B's own tail would always finish, which isn't
  // guaranteed if B crashes too).
  await new Promise(resolve => setImmediate(resolve));
  table.updateItem = realUpdateItem;
  const pastClaimExpiry = input.now + CLAIM_LEASE_MINUTES * 60 * 1000 + 1000;
  let crashedOnceForB = false;
  table.updateItem = async params => {
    if (!crashedOnceForB && params.UpdateExpression.includes('ownerExecutionArn = :unowned')) {
      crashedOnceForB = true;
      throw new Error('winner B crashed after commit, before release');
    }
    return realUpdateItem(params);
  };
  await expect(reconcile(table, { ...args, now: pastClaimExpiry })).rejects.toThrow('winner B crashed');
  table.updateItem = realUpdateItem;
  expect(table.publishCalls.length).toBe(0);
  expect(table.snapshot({ PK: COORDINATION_LOCK_PK, SK: COORDINATION_SK })?.ownerExecutionArn).toBe(input.executionArn);

  // A resumes: its own commit fails (superseded by B's claimToken), but it must finish what
  // B left undone rather than giving up because "REPORTED" was already true.
  resumeA!();
  const resultA = await writerA;
  expect(resultA.outcome).toBe('REPORTED');
  expect(resultA.lockReleased).toBe(true);
  expect(resultA.notificationPublished).toBe(true);
  expect(table.publishCalls.length).toBe(1);
  expect(table.snapshot({ PK: COORDINATION_LOCK_PK, SK: COORDINATION_SK })?.ownerExecutionArn).toBe('');
});

test('permanent-lock TTL fix: the LOCK item never carries a ttl attribute, only RUN items do', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  const { fencingToken } = await acquireLock(table, TABLE, input);

  const lock = table.snapshot({ PK: COORDINATION_LOCK_PK, SK: COORDINATION_SK });
  expect(lock).not.toHaveProperty('ttl');

  await releaseLock(table, TABLE, input.executionArn, fencingToken);
  const lockAfterRelease = table.snapshot({ PK: COORDINATION_LOCK_PK, SK: COORDINATION_SK });
  expect(lockAfterRelease).not.toHaveProperty('ttl');

  // RUN items, by contrast, are one-per-execution audit records and should expire.
  const result = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: 'arn:...:exec-with-run-ttl', status: 'FAILED', error: new Error('boom'), now: input.now,
  });
  void result;
  const run = table.snapshot(runItemKey('arn:...:exec-with-run-ttl'));
  expect(typeof run?.ttl).toBe('number');
});

test('sparse-array fix: a caught Error whose cause holds a sparse array is densified before freezing and reporting', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  const sparseError = new Error('boom');
  // eslint-disable-next-line no-sparse-arrays
  (sparseError as Error & { cause?: unknown }).cause = [, 'detail'];

  const result = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: sparseError, now: input.now,
  });
  expect(result.outcome).toBe('REPORTED');

  const body = JSON.parse(table.objects.get(result.reportKey!)!.toString('utf8'));
  expect(body.failureEvidence.cause).toEqual(['detail']); // densified, not sparse

  // A retry must reconstruct the identical (already-densified) bytes, not REPORT_CONFLICT.
  const retry = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: input.now + 1000,
  });
  expect(retry.outcome).toBe('REPORTED');
});

test('notification claim fix: a caller pausing right before its own notify does not duplicate one a concurrent caller already sent', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  // A completes report+commit, then pauses right at its own notification claim attempt.
  let resumeA: () => void;
  const gate = new Promise<void>(resolve => { resumeA = resolve; });
  const realUpdateItem = table.updateItem.bind(table);
  let paused = false;
  table.updateItem = async params => {
    if (!paused && params.UpdateExpression.includes('SET notification = :sending')) { paused = true; await gate; }
    return realUpdateItem(params);
  };
  const writerA = reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: new Error('boom'), now: input.now,
  });

  // B sees the report already committed (A got that far before pausing) and completes the
  // whole notification tail on its own, via the ALREADY_REPORTED -> finishAfterReported path.
  await new Promise(resolve => setImmediate(resolve));
  table.updateItem = realUpdateItem;
  const writerB = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: input.now + 1000,
  });
  expect(writerB.notificationPublished).toBe(true);
  expect(table.publishCalls.length).toBe(1);

  // A resumes and attempts its own claim -- it must find notification already SENT and not
  // publish a second time.
  resumeA!();
  const resultA = await writerA;
  expect(resultA.notificationPublished).toBe(true);
  expect(table.publishCalls.length).toBe(1);
});

test('notification retry fix: a failed publish attempt is retried on the next call, not treated as permanently done', async () => {
  const table = new FakeCoordinationTable();
  table.publishShouldFail = true;
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  await expect(reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: new Error('boom'), now: input.now,
  })).rejects.toThrow('SNS unavailable');
  expect(table.publishCalls.length).toBe(1);

  const run = table.snapshot(runItemKey(input.executionArn));
  const notification = run?.notification as { state?: string; lastError?: string } | undefined;
  expect(notification?.state).toBe('PENDING'); // not stuck as a permanent failure
  expect(notification?.lastError).toBe('SNS unavailable');

  table.publishShouldFail = false;
  const retry = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: input.now + 1000,
  });
  expect(retry.notificationPublished).toBe(true);
  expect(table.publishCalls.length).toBe(2); // the failed attempt, then the successful retry
  const finalNotification = table.snapshot(runItemKey(input.executionArn))?.notification as { state?: string } | undefined;
  expect(finalNotification?.state).toBe('SENT');
});

test('notification completion fencing fix: a stale claimant\'s late-arriving failure cannot revert a successor\'s SENT state', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  // A gets all the way to its own publish call and is held there.
  let resumeA: () => void;
  const gate = new Promise<void>(resolve => { resumeA = resolve; });
  const realPublish = table.publish.bind(table);
  let callCount = 0;
  table.publish = async params => {
    callCount += 1;
    if (callCount === 1) { await gate; throw new Error('A: stale network failure'); }
    return realPublish(params);
  };
  const writerA = reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: new Error('boom'), now: input.now,
  }).catch(error => error as Error);

  // B arrives after A's notification lease (not the report lease) has expired, reclaims,
  // and successfully sends -- using the fresh-clock fix, this only requires advancing past
  // the notification claim's own window, not any pre-existing staleness in report claiming.
  await new Promise(resolve => setImmediate(resolve));
  const pastNotificationLease = input.now + CLAIM_LEASE_MINUTES * 60 * 1000 + 1000;
  const writerB = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: pastNotificationLease,
  });
  expect(writerB.notificationPublished).toBe(true);
  expect(table.snapshot(runItemKey(input.executionArn))?.notification).toMatchObject({ state: 'SENT' });

  // A's stale, already-superseded publish attempt now resolves with a failure. Without the
  // claimToken fence, its catch handler would unconditionally reset notification to PENDING,
  // erasing B's successful send and letting a third caller send yet another copy.
  resumeA!();
  const resultA = await writerA;
  expect(resultA).toBeInstanceOf(Error);
  expect(table.snapshot(runItemKey(input.executionArn))?.notification).toMatchObject({ state: 'SENT' });

  const writerC = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: pastNotificationLease + 1000,
  });
  expect(writerC.notificationPublished).toBe(true);
  // A's intercepted attempt throws before reaching the real send, so it never appears in
  // publishCalls -- what matters is that the real SNS topic was only actually invoked once
  // (B's), not that C triggers a second, genuinely duplicate send on top of it.
  expect(table.publishCalls.length).toBe(1);
});

test('fresh-clock fix: a notification claim computed after reporting already consumed its full lease is not born already-expired', async () => {
  const table = new FakeCoordinationTable();
  const input = baseInput();
  await acquireLock(table, TABLE, input);

  // A pauses right before committing its report.
  let resumeA: () => void;
  const gate = new Promise<void>(resolve => { resumeA = resolve; });
  const realUpdateItem = table.updateItem.bind(table);
  let paused = false;
  table.updateItem = async params => {
    if (!paused && params.UpdateExpression.includes('reportedAt')) { paused = true; await gate; }
    return realUpdateItem(params);
  };
  const writerA = reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, runId: input.runId, cutoff: input.cutoff,
    error: new Error('boom'), now: input.now,
  });

  // B arrives after A's *report* claim lease expires (consuming the full 5 minutes) and
  // crashes right after releasing the lock -- before it can claim notification.
  await new Promise(resolve => setImmediate(resolve));
  table.updateItem = realUpdateItem;
  const afterReportLease = input.now + CLAIM_LEASE_MINUTES * 60 * 1000 + 1000;
  const realUpdateItem2 = table.updateItem.bind(table);
  let crashedForB = false;
  table.updateItem = async params => {
    if (!crashedForB && params.UpdateExpression.includes('ownerExecutionArn = :unowned')) {
      crashedForB = true;
      throw new Error('B crashed after release');
    }
    return realUpdateItem2(params);
  };
  await expect(reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: afterReportLease,
  })).rejects.toThrow('B crashed after release');
  table.updateItem = realUpdateItem2;

  // A resumes and reaches its OWN notification claim now -- table.clock is still at
  // afterReportLease (B's most recent call), which is exactly the scenario Codex
  // reproduced: if A's notification claim used input.now (its own original, now very
  // stale, timestamp) instead of a fresh read, the claim would be born already expired.
  // A resumes into its OWN notification claim, and is held inside the publish call itself
  // so the claim's actual persisted claimExpiry can be inspected while still "in flight" --
  // an earlier version of this test only checked the end state after A's publish had
  // already completed, which passes identically whether the claim was computed fresh or
  // from stale input.now, since nothing else ever contended for it while it was open. That
  // gap was caught by Codex mutation-testing the fix back out and finding this test still
  // green (STYLE_GUIDE.md Sec.5's "must fail for the correct reason" rule, applied here to
  // a committed regression test rather than a first-draft one).
  let resumePublish: () => void;
  const publishGate = new Promise<void>(resolve => { resumePublish = resolve; });
  const realPublish = table.publish.bind(table);
  let publishPaused = false;
  table.publish = async params => {
    if (!publishPaused) { publishPaused = true; await publishGate; }
    return realPublish(params);
  };

  resumeA!();
  await new Promise(resolve => setImmediate(resolve));

  const runWhilePublishing = table.snapshot(runItemKey(input.executionArn));
  const claimWhilePublishing = runWhilePublishing?.notification as { state?: string; claimExpiry?: number } | undefined;
  expect(claimWhilePublishing?.state).toBe('SENDING');
  // The claim must be freshly anchored to table.clock (afterReportLease, the most recent
  // real time this test established), not to input.now (the original, now long-stale
  // invocation timestamp) -- a stale claim would already read as expired here.
  expect(claimWhilePublishing?.claimExpiry).toBe(afterReportLease + CLAIM_LEASE_MINUTES * 60 * 1000);

  // While A's publish is still outstanding, a competing reconciliation must be rejected --
  // it must NOT be able to steal a claim that a fresh clock correctly shows as still active.
  const competitor = await reconcile(table, {
    tableName: TABLE, bucketName: BUCKET, topicArn: TOPIC,
    executionArn: input.executionArn, status: 'FAILED', now: afterReportLease + 1000,
  });
  expect(competitor.notificationPublished).toBe(false);
  expect(table.publishCalls.length).toBe(0); // A's own send hasn't completed yet either

  resumePublish!();
  const resultA = await writerA;
  expect(resultA.notificationPublished).toBe(true);
  expect(table.publishCalls.length).toBe(1);
  expect(table.snapshot(runItemKey(input.executionArn))?.notification).toMatchObject({ state: 'SENT' });
});
