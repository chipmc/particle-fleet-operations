import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import { ARCHIVE_PREFIX, canonicalSerialize } from './archive';

// Replaces the S3-object lock (dynamodb-index-archive/v1/_control/historical-rewrite.lock)
// after four consecutive review rounds each closed one gap in that mechanism and surfaced
// an adjacent one -- a same-second runId collision, a read-then-delete TOCTOU race, and a
// same-key report overwrite because a Step Functions Fail state produces execution status
// FAILED regardless of whether the in-workflow Catch or the external EventBridge cleanup
// handled it. This module is the single, independently-testable place that owns lock
// ownership (execution ARN + a monotonically increasing fencing token, never a derived
// runId), and unifies the two failure-reporting writers into one idempotent operation.

export const COORDINATION_LOCK_PK = 'LOCK#monthly-archive';
export const COORDINATION_SK = 'METADATA';
export const LOCK_LEASE_HOURS = 24;
export const RUN_ITEM_TTL_DAYS = 90;
export const CLAIM_LEASE_MINUTES = 5;

export class LockHeldError extends Error {}
export class LockFencingError extends Error {}
export class ReportConflictError extends Error {}

export function runItemKey(executionArn: string): { PK: string; SK: string } {
  return { PK: `RUN#${sha256Hex(executionArn)}`, SK: COORDINATION_SK };
}

function lockItemKey(): { PK: string; SK: string } {
  return { PK: COORDINATION_LOCK_PK, SK: COORDINATION_SK };
}

// RUN items are one-per-execution audit records, unlike the single LOCK item -- they are
// safe, and intended, to expire. Only the LOCK item must never carry a `ttl` attribute.
function runItemTtl(now: number): number {
  return Math.floor(now / 1000) + RUN_ITEM_TTL_DAYS * 24 * 60 * 60;
}

export function reportKeyFor(executionArn: string, now: number): string {
  const date = new Date(now);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${ARCHIVE_PREFIX}/reports/${yyyy}/${mm}/${sha256Hex(executionArn)}.failed.json`;
}

// Recursively omits undefined-valued object properties before serialization. Moved here
// (was previously a private helper in archive-control.ts) because both this module's
// report writes and archive-control.ts's own report writes need it, and this module is
// the lower-level one archive-control.ts already depends on.
export function omitUndefinedObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Array.from (not .map) visits sparse holes as undefined instead of skipping them, and
    // the trailing filter then drops them -- densifying the array. .map alone leaves holes
    // as holes, which downstream JSON serialization renders as a stray leading/embedded
    // comma (invalid JSON), while the real DynamoDB marshaller silently compacts them into
    // a dense list on any write. Codex reproduced the two paths diverging: an error whose
    // `cause` held a sparse array serialized differently locally than after a real
    // marshall/unmarshall round-trip, producing a false REPORT_CONFLICT on retry.
    return Array.from(value, omitUndefinedObjectProperties).filter(entry => entry !== undefined);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, property]) => property !== undefined)
        .map(([key, property]) => [key, omitUndefinedObjectProperties(property)])
    );
  }
  return value;
}

export interface LockRecord {
  ownerExecutionArn: string;
  fencingToken: number;
  leaseExpiry: number;
  startedAt: string;
  sourceTableName: string;
}

export interface RunEvidence {
  source: 'catch' | 'describe-execution' | 'describe-execution-unavailable' | 'unknown';
  sfnStatus: string | null;
  error?: string | null;
  cause?: unknown;
  startDate?: string | null;
  stopDate?: string | null;
  enrichedFromDescribeExecution?: boolean;
}

// Same first-write-wins claim shape as reporting (PENDING/WRITING/REPORTED), applied a
// second time to notification specifically. The report-claim alone does not serialize
// notification: two reconcilers can both reach "REPORTED, notification not yet attempted"
// concurrently -- one via the direct commit path, one via finishAfterReported -- and Codex
// reproduced both sending SNS. `lastError` (not folded into `attempted`) is what lets a
// failed attempt be distinguished from a real send and retried, rather than being treated
// as permanently done -- the other half of the same finding.
export interface NotificationState {
  state: 'PENDING' | 'SENDING' | 'SENT';
  claimToken?: string;
  claimExpiry?: number;
  publishedAt?: string;
  messageId?: string;
  lastError?: string;
}

export interface RunRecord {
  PK: string;
  SK: string;
  executionArn: string;
  runId?: string;
  cutoff?: string;
  status: string;
  lockFencingToken?: number;
  failureEvidence?: RunEvidence;
  reportState: 'PENDING' | 'WRITING' | 'REPORTED';
  claimToken?: string;
  claimExpiry?: number;
  reportS3Key?: string;
  reportDigestSha256?: string;
  notification?: NotificationState;
  reportConflict?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinationDependencies {
  getItem(params: { TableName: string; Key: Record<string, unknown>; ConsistentRead?: boolean }): Promise<Record<string, unknown> | undefined>;
  putItem(params: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string }): Promise<void>;
  updateItem(params: {
    TableName: string;
    Key: Record<string, unknown>;
    UpdateExpression: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  }): Promise<void>;
  transactWrite(params: { TableName: string; items: TransactItem[] }): Promise<void>;
  putObject(params: { Bucket: string; Key: string; Body: Buffer; ContentType: string; IfNoneMatch?: string }): Promise<void>;
  getObject(params: { Bucket: string; Key: string }): Promise<Buffer>;
  publish(params: { TopicArn: string; Subject: string; Message: string }): Promise<{ messageId?: string }>;
  describeExecution(executionArn: string): Promise<{ status?: string; startDate?: Date; stopDate?: Date; error?: string; cause?: string } | undefined>;
  // A fresh clock read, deliberately separate from ReconcileFailureInput.now (which is
  // sampled once, at the start of a single invocation, and is used for audit/content
  // timestamps). Codex reproduced a real gap from conflating the two: a claim/lease expiry
  // computed from an invocation-start timestamp can already be stale -- even immediately
  // expired -- by the time execution actually reaches a later claim inside the same
  // invocation, if enough real work (retries, a preceding claim's own full lease) happened
  // first. Lease computations must read the clock at the moment they claim, not reuse
  // whatever `now` happened to be passed in at the top of the call.
  now(): number;
}

export interface TransactItem {
  update?: { Key: Record<string, unknown>; UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> };
  put?: { Item: Record<string, unknown>; ConditionExpression: string };
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sns = new SNSClient({});
const sfn = new SFNClient({});

export const dependencies: CoordinationDependencies = {
  getItem: async params => (await dynamo.send(new GetCommand(params))).Item,
  putItem: async params => { await dynamo.send(new PutCommand(params)); },
  updateItem: async params => { await dynamo.send(new UpdateCommand(params)); },
  transactWrite: async params => {
    await dynamo.send(new TransactWriteCommand({
      TransactItems: params.items.map(item => {
        if (item.update) return { Update: { TableName: params.TableName, ...item.update } };
        if (item.put) return { Put: { TableName: params.TableName, ...item.put } };
        throw new Error('Invalid transact item');
      }),
    }));
  },
  putObject: async params => { await s3.send(new PutObjectCommand(params)); },
  getObject: async params => {
    const response = await s3.send(new GetObjectCommand(params));
    if (!response.Body) throw new Error('Report read-back returned an empty body');
    return Buffer.from(await response.Body.transformToByteArray());
  },
  publish: async params => {
    const response = await sns.send(new PublishCommand(params));
    return { messageId: response.MessageId };
  },
  describeExecution: async executionArn => {
    try {
      const response = await sfn.send(new DescribeExecutionCommand({ executionArn }));
      return { status: response.status, startDate: response.startDate, stopDate: response.stopDate, error: response.error, cause: response.cause };
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
};

// --- Lock lifecycle -----------------------------------------------------------------

export interface AcquireLockInput {
  executionArn: string;
  runId: string;
  cutoff: string;
  sourceTableName: string;
  now: number;
  leaseHours?: number;
}

// A released lock is never deleted -- only its ownership fields are cleared. The fencing
// token is a pure generation counter that only ever increments, across the lock's entire
// history, never resets. Deleting the item on release (the original design) let a paused,
// stale acquirer's compare-and-swap match a *later, unrelated* lock generation that
// happened to restart at the same token value after a delete-then-recreate -- an ABA race
// Codex reproduced directly. Keeping the counter alive forever removes the "A" in ABA: no
// token value the counter produces can ever be seen twice, so a stale CAS can never match
// a state it didn't actually observe.
const UNOWNED = '';

export async function acquireLock(
  deps: CoordinationDependencies,
  tableName: string,
  input: AcquireLockInput
): Promise<{ fencingToken: number }> {
  const { executionArn, runId, cutoff, sourceTableName, now } = input;
  const leaseHours = input.leaseHours ?? LOCK_LEASE_HOURS;
  const lockKey = lockItemKey();
  const runKey = runItemKey(executionArn);

  const existingLock = (await deps.getItem({ TableName: tableName, Key: lockKey, ConsistentRead: true })) as Partial<LockRecord> | undefined;

  if (existingLock && existingLock.ownerExecutionArn === executionArn && typeof existingLock.leaseExpiry === 'number' && existingLock.leaseExpiry > now) {
    const run = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
    if (run && typeof run.lockFencingToken === 'number') return { fencingToken: run.lockFencingToken };
    throw new LockFencingError('Lock is owned by this execution but its RUN item has no recorded fencing token; refusing to guess.');
  }

  const held = existingLock && existingLock.ownerExecutionArn !== UNOWNED && typeof existingLock.leaseExpiry === 'number' && existingLock.leaseExpiry > now;
  if (held) {
    throw new LockHeldError('Historical rewrite lock already held by another execution.');
  }

  const prevToken = existingLock && typeof existingLock.fencingToken === 'number' ? existingLock.fencingToken : 0;
  const nextToken = prevToken + 1;
  const leaseExpiry = now + leaseHours * 60 * 60 * 1000;
  const nowIso = new Date(now).toISOString();

  try {
    await deps.transactWrite({
      TableName: tableName,
      items: [
        {
          // Deliberately no `ttl` attribute on this item, ever. It was originally set here
          // (cleanup-only, "never read for correctness") but Codex reproduced that DynamoDB's
          // own TTL sweep is itself a deletion path -- exactly the one releaseLock was fixed
          // to stop using -- so a lock item that carries a TTL is still eventually deleted out
          // from under the "permanent counter" guarantee, reopening the same ABA class through
          // a different door. The RUN items (one per execution, fine to expire) still carry a
          // TTL; this table's one LOCK#monthly-archive item must never carry one.
          update: {
            Key: lockKey,
            UpdateExpression: 'SET ownerExecutionArn = :arn, fencingToken = :nextToken, leaseExpiry = :leaseExpiry, startedAt = :nowIso, sourceTableName = :sourceTableName',
            ConditionExpression: existingLock ? 'fencingToken = :prevToken' : 'attribute_not_exists(PK)',
            ExpressionAttributeValues: {
              ':arn': executionArn,
              ':nextToken': nextToken,
              ':leaseExpiry': leaseExpiry,
              ':nowIso': nowIso,
              ':sourceTableName': sourceTableName,
              ...(existingLock ? { ':prevToken': prevToken } : {}),
            },
          },
        },
        {
          put: {
            Item: omitUndefinedObjectProperties({
              ...runKey,
              executionArn,
              runId,
              cutoff,
              status: 'STARTED',
              lockFencingToken: nextToken,
              reportState: 'PENDING',
              createdAt: nowIso,
              updatedAt: nowIso,
              ttl: runItemTtl(now),
            }) as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    });
  } catch (error) {
    if (isTransactionCanceled(error)) {
      throw new LockHeldError('Historical rewrite lock already held, or a RUN item already exists for this execution.');
    }
    throw error;
  }

  return { fencingToken: nextToken };
}

export async function assertLockHeld(
  deps: CoordinationDependencies,
  tableName: string,
  executionArn: string,
  fencingToken: number
): Promise<void> {
  const lock = (await deps.getItem({ TableName: tableName, Key: lockItemKey(), ConsistentRead: true })) as Partial<LockRecord> | undefined;
  if (!lock) throw new LockFencingError('Archive coordination lock is absent.');
  if (lock.ownerExecutionArn !== executionArn || lock.fencingToken !== fencingToken) {
    throw new LockFencingError('Archive coordination lock is held by a different execution or fencing token.');
  }
}

export async function releaseLock(
  deps: CoordinationDependencies,
  tableName: string,
  executionArn: string,
  fencingToken: number
): Promise<{ released: boolean; reason?: string }> {
  try {
    // Clears ownership only -- fencingToken is deliberately left untouched (see UNOWNED's
    // comment above). Still a single conditional write with no preceding read: the TOCTOU
    // property this replaces the old S3 lock's read-then-delete for is unaffected by
    // switching Delete to Update, only the "does release erase history" bug is fixed.
    await deps.updateItem({
      TableName: tableName,
      Key: lockItemKey(),
      UpdateExpression: 'SET ownerExecutionArn = :unowned, leaseExpiry = :zero',
      ConditionExpression: 'ownerExecutionArn = :arn AND fencingToken = :token',
      ExpressionAttributeValues: { ':arn': executionArn, ':token': fencingToken, ':unowned': UNOWNED, ':zero': 0 },
    });
    return { released: true };
  } catch (error) {
    if (isConditionalCheckFailed(error)) return { released: false, reason: 'lock-not-held' };
    throw error;
  }
}

// --- Unified failure reconciliation --------------------------------------------------

export type ReconcileOutcome = 'REPORTED' | 'CLAIM_HELD_ELSEWHERE' | 'REPORT_CONFLICT';

export interface ReconcileFailureInput {
  tableName: string;
  bucketName: string;
  topicArn: string;
  executionArn: string;
  runId?: string;
  cutoff?: string;
  status?: string;
  error?: unknown;
  now: number;
}

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  reportKey?: string;
  lockReleased: boolean;
  notificationPublished: boolean;
}

export async function reconcileFailure(deps: CoordinationDependencies, input: ReconcileFailureInput): Promise<ReconcileResult> {
  const runKey = runItemKey(input.executionArn);
  let run = await ensureRunItem(deps, input, runKey);

  if (!run.failureEvidence) {
    const evidence = await enrichEvidence(deps, input);
    const reportKey = reportKeyFor(input.executionArn, input.now);
    run = await freezeEvidenceAndReportKey(deps, input.tableName, runKey, evidence, reportKey, run);
  }
  // From here on, run.failureEvidence and run.reportS3Key are immutable for this execution
  // -- frozen together in the same first-write-wins update above, so every entry point
  // (Catch, EventBridge, any retry from either) reconstructs byte-identical report content
  // from this point forward, regardless of what its own live input.status/input.error say.

  const claim = await claimReporting(deps, input.tableName, runKey);
  if (claim.outcome === 'ALREADY_REPORTED') {
    return finishAfterReported(deps, input, claim.run);
  }
  if (claim.outcome === 'CLAIM_HELD_ELSEWHERE') {
    // A prior caller's claim is still active (reportState stays WRITING after
    // recordReportConflict -- it is never reset), so without this check every caller
    // arriving during that ~5-minute window would see CLAIM_HELD_ELSEWHERE and report
    // success, silently swallowing a genuine conflict that the very first caller already
    // discovered and recorded. Once persisted, reportConflict must stay visible to every
    // subsequent caller, not just the one that found it.
    if (claim.run?.reportConflict) {
      return { outcome: 'REPORT_CONFLICT', reportKey: claim.run.reportS3Key, lockReleased: false, notificationPublished: false };
    }
    return { outcome: 'CLAIM_HELD_ELSEWHERE', lockReleased: false, notificationPublished: false };
  }

  const reportKey = run.reportS3Key!;
  const report = buildCanonicalReport(run);
  const digest = sha256Hex(canonicalSerialize(omitUndefinedObjectProperties(report)));

  const writeOutcome = await writeReportIdempotent(deps, input.bucketName, reportKey, report, digest);
  if (writeOutcome === 'CONFLICT') {
    await recordReportConflict(deps, input.tableName, runKey);
    return { outcome: 'REPORT_CONFLICT', reportKey, lockReleased: false, notificationPublished: false };
  }

  const commit = await commitReported(deps, input.tableName, runKey, claim.claimToken, digest, input.now);
  if (!commit.committedByMe) {
    // Superseded by a different claimant -- but that claimant may itself have crashed
    // before finishing release/notify, so resume via the same fresh-state path rather than
    // unconditionally assuming its tail completed (that assumption was the original bug).
    return finishAfterReported(deps, input, commit.run);
  }

  const lockReleased = await releaseIfHeld(deps, input, run);
  const notificationPublished = await claimAndPublishNotification(deps, input, report, reportKey);

  return { outcome: 'REPORTED', reportKey, lockReleased, notificationPublished };
}

// Shared tail for "the report is already REPORTED" -- reached either because claimReporting
// found it so directly, or because this run had no unrecorded evidence to begin with. Must
// still resume a lock release and/or notification that an earlier crash left undone; must
// NOT re-attempt the S3 write (already done, per definition of REPORTED). Always calls
// claimAndPublishNotification rather than pre-checking run.notification locally -- that
// local check was itself the bug (a stale snapshot could read as "not yet attempted" while
// a concurrent caller was already sending, or had already sent); the claim call is what
// actually knows the current state, atomically, at the moment it matters.
async function finishAfterReported(deps: CoordinationDependencies, input: ReconcileFailureInput, run: RunRecord): Promise<ReconcileResult> {
  const lockReleased = await releaseIfHeld(deps, input, run);
  let notificationPublished = false;
  if (run.reportS3Key) {
    const report = buildCanonicalReport(run);
    notificationPublished = await claimAndPublishNotification(deps, input, report, run.reportS3Key);
  }
  return { outcome: 'REPORTED', reportKey: run.reportS3Key, lockReleased, notificationPublished };
}

async function ensureRunItem(deps: CoordinationDependencies, input: ReconcileFailureInput, runKey: { PK: string; SK: string }): Promise<RunRecord> {
  const existing = (await deps.getItem({ TableName: input.tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
  if (existing) return existing;

  const nowIso = new Date(input.now).toISOString();
  const item = omitUndefinedObjectProperties({
    ...runKey,
    executionArn: input.executionArn,
    runId: input.runId,
    cutoff: input.cutoff,
    status: 'FAILED',
    reportState: 'PENDING',
    createdAt: nowIso,
    updatedAt: nowIso,
    ttl: runItemTtl(input.now),
  }) as RunRecord;

  try {
    await deps.putItem({ TableName: input.tableName, Item: item as unknown as Record<string, unknown>, ConditionExpression: 'attribute_not_exists(PK)' });
    return item;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const raced = (await deps.getItem({ TableName: input.tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
      if (raced) return raced;
    }
    throw error;
  }
}

async function enrichEvidence(deps: CoordinationDependencies, input: ReconcileFailureInput): Promise<RunEvidence> {
  if (input.error !== undefined) {
    return { source: 'catch', sfnStatus: input.status ?? null, error: errorMessage(input.error), cause: extractCause(input.error) };
  }
  const execution = await deps.describeExecution(input.executionArn);
  if (!execution) return { source: 'describe-execution-unavailable', sfnStatus: input.status ?? null };
  return {
    source: 'describe-execution',
    sfnStatus: execution.status ?? input.status ?? null,
    startDate: execution.startDate ? execution.startDate.toISOString() : null,
    stopDate: execution.stopDate ? execution.stopDate.toISOString() : null,
    error: execution.error ?? null,
    cause: execution.cause ?? null,
    enrichedFromDescribeExecution: true,
  };
}

// First-write-wins on failureEvidence specifically (attribute_not_exists(failureEvidence)),
// not merely "reportState is still PENDING" (the original, broader condition). Two
// concurrent reconcilers can both observe PENDING before either writes, so gating on
// reportState alone let a second writer overwrite the first's evidence with its own --
// Codex reproduced this leading to a permanent false REPORT_CONFLICT on retry, since a
// later retry could rebuild the report from whichever evidence happened to be persisted
// last, which need not match what was already written to S3. Freezing evidence AND the
// report key in the same conditional update guarantees every future read of this RUN item
// reconstructs identical report bytes, regardless of which entry point or how many retries
// touch it after this point.
async function freezeEvidenceAndReportKey(
  deps: CoordinationDependencies,
  tableName: string,
  runKey: { PK: string; SK: string },
  evidence: RunEvidence,
  reportKey: string,
  run: RunRecord
): Promise<RunRecord> {
  try {
    await deps.updateItem({
      TableName: tableName,
      Key: runKey,
      UpdateExpression: 'SET failureEvidence = :evidence, reportS3Key = :reportKey, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(failureEvidence)',
      ExpressionAttributeValues: { ':evidence': omitUndefinedObjectProperties(evidence), ':reportKey': reportKey, ':now': new Date().toISOString() },
    });
    return { ...run, failureEvidence: evidence, reportS3Key: reportKey };
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const fresh = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
      return fresh || run;
    }
    throw error;
  }
}

type ClaimOutcome =
  | { outcome: 'CLAIMED'; claimToken: string }
  | { outcome: 'ALREADY_REPORTED'; run: RunRecord }
  | { outcome: 'CLAIM_HELD_ELSEWHERE'; run?: RunRecord };

async function claimReporting(deps: CoordinationDependencies, tableName: string, runKey: { PK: string; SK: string }): Promise<ClaimOutcome> {
  const claimToken = randomUUID();
  // A fresh clock read, not the invocation-start `input.now` -- see the CoordinationDependencies.now
  // comment. Report-claiming is usually early in a reconciliation, but "usually" isn't a
  // guarantee (retries in ensureRunItem/freezeEvidenceAndReportKey can precede it), and this
  // exact conflation is what Codex's fourth-pass review found live in the notification claim.
  const freshNow = deps.now();
  const claimExpiry = freshNow + CLAIM_LEASE_MINUTES * 60 * 1000;
  try {
    await deps.updateItem({
      TableName: tableName,
      Key: runKey,
      UpdateExpression: 'SET reportState = :writing, claimToken = :claimToken, claimExpiry = :claimExpiry, updatedAt = :nowIso',
      ConditionExpression: 'reportState = :pending OR (reportState = :writing AND claimExpiry < :now)',
      ExpressionAttributeValues: {
        ':writing': 'WRITING',
        ':pending': 'PENDING',
        ':claimToken': claimToken,
        ':claimExpiry': claimExpiry,
        ':now': freshNow,
        ':nowIso': new Date(freshNow).toISOString(),
      },
    });
    return { outcome: 'CLAIMED', claimToken };
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    // Freshly read, not the caller's pre-claim snapshot: another invocation may have run
    // its entire reconciliation -- including notification -- in the time between this
    // caller's own RUN read and this claim attempt. Codex reproduced a duplicate SNS
    // publish from exactly this staleness when the caller's original snapshot was used
    // instead. Every "already done" path must hand off this fresh state, not the stale one.
    const current = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
    if (current?.reportState === 'REPORTED') return { outcome: 'ALREADY_REPORTED', run: current };
    return { outcome: 'CLAIM_HELD_ELSEWHERE', run: current };
  }
}

// Built exclusively from the frozen RunRecord -- never from a caller's live input.status or
// input.error, which can legitimately differ between the in-workflow Catch path and an
// EventBridge/DescribeExecution-derived retry for the very same execution. Using live input
// here was the other half of the false-REPORT_CONFLICT bug: it made the digest depend on
// which entry point happened to be reconstructing the report, not on what was persisted.
function buildCanonicalReport(run: RunRecord): Record<string, unknown> {
  return {
    status: 'FAILED',
    executionArn: run.executionArn,
    runId: run.runId ?? null,
    cutoff: run.cutoff ?? null,
    executionStatus: run.failureEvidence?.sfnStatus ?? null,
    failureEvidence: run.failureEvidence ?? null,
  };
}

type WriteOutcome = 'WRITTEN' | 'ALREADY_WRITTEN' | 'CONFLICT';

async function writeReportIdempotent(
  deps: CoordinationDependencies,
  bucketName: string,
  reportKey: string,
  report: Record<string, unknown>,
  digest: string
): Promise<WriteOutcome> {
  const body = Buffer.from(canonicalSerialize(omitUndefinedObjectProperties(report)));
  try {
    await deps.putObject({ Bucket: bucketName, Key: reportKey, Body: body, ContentType: 'application/json', IfNoneMatch: '*' });
    return 'WRITTEN';
  } catch (error) {
    if (!isPreconditionFailed(error)) throw error;
    const existing = await deps.getObject({ Bucket: bucketName, Key: reportKey });
    return sha256Hex(existing) === digest ? 'ALREADY_WRITTEN' : 'CONFLICT';
  }
}

async function recordReportConflict(deps: CoordinationDependencies, tableName: string, runKey: { PK: string; SK: string }): Promise<void> {
  await deps.updateItem({
    TableName: tableName,
    Key: runKey,
    UpdateExpression: 'SET reportConflict = :true, updatedAt = :now',
    ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
  });
}

// Returns committedByMe: false when this invocation's claim was superseded -- its claim
// lease expired and a different claimant already finished the job while this call was
// still mid-write. Conflating "the run is REPORTED" with "I am the one who reported it"
// (the original bug) let a superseded claimant fall through to release-and-notify a second
// time, producing a duplicate SNS publish beyond the already-accepted at-least-once
// tolerance for *retries* of the same claim, not for genuinely different claimants.
type CommitOutcome = { committedByMe: true } | { committedByMe: false; run: RunRecord };

async function commitReported(
  deps: CoordinationDependencies,
  tableName: string,
  runKey: { PK: string; SK: string },
  claimToken: string,
  digest: string,
  now: number
): Promise<CommitOutcome> {
  try {
    await deps.updateItem({
      TableName: tableName,
      Key: runKey,
      UpdateExpression: 'SET reportState = :reported, reportDigestSha256 = :digest, reportedAt = :nowIso, updatedAt = :nowIso',
      ConditionExpression: 'claimToken = :claimToken AND reportState = :writing',
      ExpressionAttributeValues: {
        ':reported': 'REPORTED',
        ':writing': 'WRITING',
        ':claimToken': claimToken,
        ':digest': digest,
        ':nowIso': new Date(now).toISOString(),
      },
    });
    return { committedByMe: true };
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    const current = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
    if (current?.reportState === 'REPORTED' && current.claimToken === claimToken) return { committedByMe: true };
    // Superseded by a different claimant. Hand back the freshly read state (not this
    // caller's stale pre-claim snapshot) so the caller can still resume any release/notify
    // the winner itself left unfinished -- see finishAfterReported and the reconcileFailure
    // call site. Returning here unconditionally, without that fresh state, was the original
    // bug: it made this caller give up entirely on the assumption the winner would always
    // finish its own tail, which isn't guaranteed if the winner also crashes.
    if (current?.reportState === 'REPORTED') return { committedByMe: false, run: current };
    throw error;
  }
}

async function releaseIfHeld(deps: CoordinationDependencies, input: ReconcileFailureInput, run: RunRecord): Promise<boolean> {
  if (typeof run.lockFencingToken !== 'number') return false;
  const result = await releaseLock(deps, input.tableName, input.executionArn, run.lockFencingToken);
  return result.released;
}

// Claims the right to notify before calling SNS, mirroring claimReporting's PENDING/
// WRITING/REPORTED pattern one level up: attempting to publish first and only recording
// state afterward (the original design) has no way to stop two reconcilers -- one on the
// direct commit path, one on the finishAfterReported tail -- from both reaching "not yet
// notified" and both publishing, since neither's local state reflects the other's
// concurrent progress. Claiming first, atomically, closes that regardless of which path
// either caller took to get here. A failed publish resets to PENDING (with lastError, not
// folded into a generic "attempted" flag) so a later caller can retry it rather than
// mistaking the failed attempt for a real send.
async function claimAndPublishNotification(
  deps: CoordinationDependencies,
  input: ReconcileFailureInput,
  report: Record<string, unknown>,
  reportKey: string
): Promise<boolean> {
  const runKey = runItemKey(input.executionArn);
  const claimToken = randomUUID();
  // Fresh clock read at the moment of claiming, not input.now -- see claimReporting and the
  // CoordinationDependencies.now comment. This is the specific spot Codex's fourth-pass
  // review reproduced: reporting can consume most or all of its own lease before this point
  // is even reached, so input.now can already be stale by the time a notification claim is
  // computed from it, sometimes stale enough that the claim is born already-expired.
  const freshNow = deps.now();
  const claimExpiry = freshNow + CLAIM_LEASE_MINUTES * 60 * 1000;
  const nowIso = new Date(freshNow).toISOString();

  try {
    await deps.updateItem({
      TableName: input.tableName,
      Key: runKey,
      UpdateExpression: 'SET notification = :sending, updatedAt = :nowIso',
      ConditionExpression: 'attribute_not_exists(notification) OR notification.#state = :pending OR (notification.#state = :sendingState AND notification.claimExpiry < :now)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':sending': { state: 'SENDING', claimToken, claimExpiry },
        ':pending': 'PENDING',
        ':sendingState': 'SENDING',
        ':now': freshNow,
        ':nowIso': nowIso,
      },
    });
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    const current = (await deps.getItem({ TableName: input.tableName, Key: runKey, ConsistentRead: true })) as RunRecord | undefined;
    return current?.notification?.state === 'SENT';
  }

  const reportRunId = typeof report.runId === 'string' ? report.runId : undefined;
  try {
    const result = await deps.publish({
      TopicArn: input.topicArn,
      Subject: `[Particle archive] FAILED ${reportRunId ?? input.executionArn}`,
      Message: JSON.stringify({ ...report, reportKey }, null, 2),
    });
    // Best-effort bookkeeping: the publish already succeeded, so a failure recording that
    // fact must not surface as an error (it would falsely mark this invocation failed and
    // get retried, publishing a second, genuinely duplicate notification). Fenced on
    // claimToken so a claimant whose lease has since been taken over cannot clobber the
    // new holder's state (Codex's fourth-pass first finding: an unconditional write here
    // let a superseded caller's late-arriving success or failure overwrite a successor's
    // already-correct SENT record).
    await deps.updateItem({
      TableName: input.tableName,
      Key: runKey,
      UpdateExpression: 'SET notification = :sent, updatedAt = :now',
      ConditionExpression: 'notification.claimToken = :claimToken',
      ExpressionAttributeValues: {
        ':sent': omitUndefinedObjectProperties({ state: 'SENT', publishedAt: new Date().toISOString(), messageId: result.messageId }),
        ':claimToken': claimToken,
        ':now': new Date().toISOString(),
      },
    }).catch(() => {});
    return true;
  } catch (error) {
    await deps.updateItem({
      TableName: input.tableName,
      Key: runKey,
      UpdateExpression: 'SET notification = :pending, updatedAt = :now',
      ConditionExpression: 'notification.claimToken = :claimToken',
      ExpressionAttributeValues: {
        ':pending': { state: 'PENDING', lastError: errorMessage(error) },
        ':claimToken': claimToken,
        ':now': new Date().toISOString(),
      },
    }).catch(() => {});
    throw error;
  }
}

// --- Shared helpers -------------------------------------------------------------------

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (error as { name?: string })?.name === 'ConditionalCheckFailedException';
}

function isTransactionCanceled(error: unknown): boolean {
  return (error as { name?: string })?.name === 'TransactionCanceledException';
}

function isPreconditionFailed(error: unknown): boolean {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractCause(error: unknown): unknown {
  return error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
}
