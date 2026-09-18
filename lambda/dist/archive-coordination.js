"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dependencies = exports.ReportConflictError = exports.LockFencingError = exports.LockHeldError = exports.CLAIM_LEASE_MINUTES = exports.RUN_ITEM_TTL_DAYS = exports.LOCK_LEASE_HOURS = exports.COORDINATION_SK = exports.COORDINATION_LOCK_PK = void 0;
exports.runItemKey = runItemKey;
exports.reportKeyFor = reportKeyFor;
exports.omitUndefinedObjectProperties = omitUndefinedObjectProperties;
exports.acquireLock = acquireLock;
exports.assertLockHeld = assertLockHeld;
exports.releaseLock = releaseLock;
exports.reconcileFailure = reconcileFailure;
const crypto_1 = require("crypto");
const crypto_2 = require("crypto");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_s3_1 = require("@aws-sdk/client-s3");
const client_sns_1 = require("@aws-sdk/client-sns");
const client_sfn_1 = require("@aws-sdk/client-sfn");
const archive_1 = require("./archive");
// Replaces the S3-object lock (dynamodb-index-archive/v1/_control/historical-rewrite.lock)
// after four consecutive review rounds each closed one gap in that mechanism and surfaced
// an adjacent one -- a same-second runId collision, a read-then-delete TOCTOU race, and a
// same-key report overwrite because a Step Functions Fail state produces execution status
// FAILED regardless of whether the in-workflow Catch or the external EventBridge cleanup
// handled it. This module is the single, independently-testable place that owns lock
// ownership (execution ARN + a monotonically increasing fencing token, never a derived
// runId), and unifies the two failure-reporting writers into one idempotent operation.
exports.COORDINATION_LOCK_PK = 'LOCK#monthly-archive';
exports.COORDINATION_SK = 'METADATA';
exports.LOCK_LEASE_HOURS = 24;
exports.RUN_ITEM_TTL_DAYS = 90;
exports.CLAIM_LEASE_MINUTES = 5;
class LockHeldError extends Error {
}
exports.LockHeldError = LockHeldError;
class LockFencingError extends Error {
}
exports.LockFencingError = LockFencingError;
class ReportConflictError extends Error {
}
exports.ReportConflictError = ReportConflictError;
function runItemKey(executionArn) {
    return { PK: `RUN#${sha256Hex(executionArn)}`, SK: exports.COORDINATION_SK };
}
function lockItemKey() {
    return { PK: exports.COORDINATION_LOCK_PK, SK: exports.COORDINATION_SK };
}
// RUN items are one-per-execution audit records, unlike the single LOCK item -- they are
// safe, and intended, to expire. Only the LOCK item must never carry a `ttl` attribute.
function runItemTtl(now) {
    return Math.floor(now / 1000) + exports.RUN_ITEM_TTL_DAYS * 24 * 60 * 60;
}
function reportKeyFor(executionArn, now) {
    const date = new Date(now);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${archive_1.ARCHIVE_PREFIX}/reports/${yyyy}/${mm}/${sha256Hex(executionArn)}.failed.json`;
}
// Recursively omits undefined-valued object properties before serialization. Moved here
// (was previously a private helper in archive-control.ts) because both this module's
// report writes and archive-control.ts's own report writes need it, and this module is
// the lower-level one archive-control.ts already depends on.
function omitUndefinedObjectProperties(value) {
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
        return Object.fromEntries(Object.entries(value)
            .filter(([, property]) => property !== undefined)
            .map(([key, property]) => [key, omitUndefinedObjectProperties(property)]));
    }
    return value;
}
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const s3 = new client_s3_1.S3Client({});
const sns = new client_sns_1.SNSClient({});
const sfn = new client_sfn_1.SFNClient({});
exports.dependencies = {
    getItem: async (params) => (await dynamo.send(new lib_dynamodb_1.GetCommand(params))).Item,
    putItem: async (params) => { await dynamo.send(new lib_dynamodb_1.PutCommand(params)); },
    updateItem: async (params) => { await dynamo.send(new lib_dynamodb_1.UpdateCommand(params)); },
    transactWrite: async (params) => {
        await dynamo.send(new lib_dynamodb_1.TransactWriteCommand({
            TransactItems: params.items.map(item => {
                if (item.update)
                    return { Update: { TableName: params.TableName, ...item.update } };
                if (item.put)
                    return { Put: { TableName: params.TableName, ...item.put } };
                throw new Error('Invalid transact item');
            }),
        }));
    },
    putObject: async (params) => { await s3.send(new client_s3_1.PutObjectCommand(params)); },
    getObject: async (params) => {
        const response = await s3.send(new client_s3_1.GetObjectCommand(params));
        if (!response.Body)
            throw new Error('Report read-back returned an empty body');
        return Buffer.from(await response.Body.transformToByteArray());
    },
    publish: async (params) => {
        const response = await sns.send(new client_sns_1.PublishCommand(params));
        return { messageId: response.MessageId };
    },
    describeExecution: async (executionArn) => {
        try {
            const response = await sfn.send(new client_sfn_1.DescribeExecutionCommand({ executionArn }));
            return { status: response.status, startDate: response.startDate, stopDate: response.stopDate, error: response.error, cause: response.cause };
        }
        catch {
            return undefined;
        }
    },
    now: () => Date.now(),
};
// A released lock is never deleted -- only its ownership fields are cleared. The fencing
// token is a pure generation counter that only ever increments, across the lock's entire
// history, never resets. Deleting the item on release (the original design) let a paused,
// stale acquirer's compare-and-swap match a *later, unrelated* lock generation that
// happened to restart at the same token value after a delete-then-recreate -- an ABA race
// Codex reproduced directly. Keeping the counter alive forever removes the "A" in ABA: no
// token value the counter produces can ever be seen twice, so a stale CAS can never match
// a state it didn't actually observe.
const UNOWNED = '';
async function acquireLock(deps, tableName, input) {
    const { executionArn, runId, cutoff, sourceTableName, now } = input;
    const leaseHours = input.leaseHours ?? exports.LOCK_LEASE_HOURS;
    const lockKey = lockItemKey();
    const runKey = runItemKey(executionArn);
    const existingLock = (await deps.getItem({ TableName: tableName, Key: lockKey, ConsistentRead: true }));
    if (existingLock && existingLock.ownerExecutionArn === executionArn && typeof existingLock.leaseExpiry === 'number' && existingLock.leaseExpiry > now) {
        const run = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true }));
        if (run && typeof run.lockFencingToken === 'number')
            return { fencingToken: run.lockFencingToken };
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
                        }),
                        ConditionExpression: 'attribute_not_exists(PK)',
                    },
                },
            ],
        });
    }
    catch (error) {
        if (isTransactionCanceled(error)) {
            throw new LockHeldError('Historical rewrite lock already held, or a RUN item already exists for this execution.');
        }
        throw error;
    }
    return { fencingToken: nextToken };
}
async function assertLockHeld(deps, tableName, executionArn, fencingToken) {
    const lock = (await deps.getItem({ TableName: tableName, Key: lockItemKey(), ConsistentRead: true }));
    if (!lock)
        throw new LockFencingError('Archive coordination lock is absent.');
    if (lock.ownerExecutionArn !== executionArn || lock.fencingToken !== fencingToken) {
        throw new LockFencingError('Archive coordination lock is held by a different execution or fencing token.');
    }
}
async function releaseLock(deps, tableName, executionArn, fencingToken) {
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
    }
    catch (error) {
        if (isConditionalCheckFailed(error))
            return { released: false, reason: 'lock-not-held' };
        throw error;
    }
}
async function reconcileFailure(deps, input) {
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
    const reportKey = run.reportS3Key;
    const report = buildCanonicalReport(run);
    const digest = sha256Hex((0, archive_1.canonicalSerialize)(omitUndefinedObjectProperties(report)));
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
async function finishAfterReported(deps, input, run) {
    const lockReleased = await releaseIfHeld(deps, input, run);
    let notificationPublished = false;
    if (run.reportS3Key) {
        const report = buildCanonicalReport(run);
        notificationPublished = await claimAndPublishNotification(deps, input, report, run.reportS3Key);
    }
    return { outcome: 'REPORTED', reportKey: run.reportS3Key, lockReleased, notificationPublished };
}
async function ensureRunItem(deps, input, runKey) {
    const existing = (await deps.getItem({ TableName: input.tableName, Key: runKey, ConsistentRead: true }));
    if (existing)
        return existing;
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
    });
    try {
        await deps.putItem({ TableName: input.tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' });
        return item;
    }
    catch (error) {
        if (isConditionalCheckFailed(error)) {
            const raced = (await deps.getItem({ TableName: input.tableName, Key: runKey, ConsistentRead: true }));
            if (raced)
                return raced;
        }
        throw error;
    }
}
async function enrichEvidence(deps, input) {
    if (input.error !== undefined) {
        return { source: 'catch', sfnStatus: input.status ?? null, error: errorMessage(input.error), cause: extractCause(input.error) };
    }
    const execution = await deps.describeExecution(input.executionArn);
    if (!execution)
        return { source: 'describe-execution-unavailable', sfnStatus: input.status ?? null };
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
async function freezeEvidenceAndReportKey(deps, tableName, runKey, evidence, reportKey, run) {
    try {
        await deps.updateItem({
            TableName: tableName,
            Key: runKey,
            UpdateExpression: 'SET failureEvidence = :evidence, reportS3Key = :reportKey, updatedAt = :now',
            ConditionExpression: 'attribute_not_exists(failureEvidence)',
            ExpressionAttributeValues: { ':evidence': omitUndefinedObjectProperties(evidence), ':reportKey': reportKey, ':now': new Date().toISOString() },
        });
        return { ...run, failureEvidence: evidence, reportS3Key: reportKey };
    }
    catch (error) {
        if (isConditionalCheckFailed(error)) {
            const fresh = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true }));
            return fresh || run;
        }
        throw error;
    }
}
async function claimReporting(deps, tableName, runKey) {
    const claimToken = (0, crypto_2.randomUUID)();
    // A fresh clock read, not the invocation-start `input.now` -- see the CoordinationDependencies.now
    // comment. Report-claiming is usually early in a reconciliation, but "usually" isn't a
    // guarantee (retries in ensureRunItem/freezeEvidenceAndReportKey can precede it), and this
    // exact conflation is what Codex's fourth-pass review found live in the notification claim.
    const freshNow = deps.now();
    const claimExpiry = freshNow + exports.CLAIM_LEASE_MINUTES * 60 * 1000;
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
    }
    catch (error) {
        if (!isConditionalCheckFailed(error))
            throw error;
        // Freshly read, not the caller's pre-claim snapshot: another invocation may have run
        // its entire reconciliation -- including notification -- in the time between this
        // caller's own RUN read and this claim attempt. Codex reproduced a duplicate SNS
        // publish from exactly this staleness when the caller's original snapshot was used
        // instead. Every "already done" path must hand off this fresh state, not the stale one.
        const current = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true }));
        if (current?.reportState === 'REPORTED')
            return { outcome: 'ALREADY_REPORTED', run: current };
        return { outcome: 'CLAIM_HELD_ELSEWHERE', run: current };
    }
}
// Built exclusively from the frozen RunRecord -- never from a caller's live input.status or
// input.error, which can legitimately differ between the in-workflow Catch path and an
// EventBridge/DescribeExecution-derived retry for the very same execution. Using live input
// here was the other half of the false-REPORT_CONFLICT bug: it made the digest depend on
// which entry point happened to be reconstructing the report, not on what was persisted.
function buildCanonicalReport(run) {
    return {
        status: 'FAILED',
        executionArn: run.executionArn,
        runId: run.runId ?? null,
        cutoff: run.cutoff ?? null,
        executionStatus: run.failureEvidence?.sfnStatus ?? null,
        failureEvidence: run.failureEvidence ?? null,
    };
}
async function writeReportIdempotent(deps, bucketName, reportKey, report, digest) {
    const body = Buffer.from((0, archive_1.canonicalSerialize)(omitUndefinedObjectProperties(report)));
    try {
        await deps.putObject({ Bucket: bucketName, Key: reportKey, Body: body, ContentType: 'application/json', IfNoneMatch: '*' });
        return 'WRITTEN';
    }
    catch (error) {
        if (!isPreconditionFailed(error))
            throw error;
        const existing = await deps.getObject({ Bucket: bucketName, Key: reportKey });
        return sha256Hex(existing) === digest ? 'ALREADY_WRITTEN' : 'CONFLICT';
    }
}
async function recordReportConflict(deps, tableName, runKey) {
    await deps.updateItem({
        TableName: tableName,
        Key: runKey,
        UpdateExpression: 'SET reportConflict = :true, updatedAt = :now',
        ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
    });
}
async function commitReported(deps, tableName, runKey, claimToken, digest, now) {
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
    }
    catch (error) {
        if (!isConditionalCheckFailed(error))
            throw error;
        const current = (await deps.getItem({ TableName: tableName, Key: runKey, ConsistentRead: true }));
        if (current?.reportState === 'REPORTED' && current.claimToken === claimToken)
            return { committedByMe: true };
        // Superseded by a different claimant. Hand back the freshly read state (not this
        // caller's stale pre-claim snapshot) so the caller can still resume any release/notify
        // the winner itself left unfinished -- see finishAfterReported and the reconcileFailure
        // call site. Returning here unconditionally, without that fresh state, was the original
        // bug: it made this caller give up entirely on the assumption the winner would always
        // finish its own tail, which isn't guaranteed if the winner also crashes.
        if (current?.reportState === 'REPORTED')
            return { committedByMe: false, run: current };
        throw error;
    }
}
async function releaseIfHeld(deps, input, run) {
    if (typeof run.lockFencingToken !== 'number')
        return false;
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
async function claimAndPublishNotification(deps, input, report, reportKey) {
    const runKey = runItemKey(input.executionArn);
    const claimToken = (0, crypto_2.randomUUID)();
    // Fresh clock read at the moment of claiming, not input.now -- see claimReporting and the
    // CoordinationDependencies.now comment. This is the specific spot Codex's fourth-pass
    // review reproduced: reporting can consume most or all of its own lease before this point
    // is even reached, so input.now can already be stale by the time a notification claim is
    // computed from it, sometimes stale enough that the claim is born already-expired.
    const freshNow = deps.now();
    const claimExpiry = freshNow + exports.CLAIM_LEASE_MINUTES * 60 * 1000;
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
    }
    catch (error) {
        if (!isConditionalCheckFailed(error))
            throw error;
        const current = (await deps.getItem({ TableName: input.tableName, Key: runKey, ConsistentRead: true }));
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
        }).catch(() => { });
        return true;
    }
    catch (error) {
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
        }).catch(() => { });
        throw error;
    }
}
// --- Shared helpers -------------------------------------------------------------------
function sha256Hex(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest('hex');
}
function isConditionalCheckFailed(error) {
    return error?.name === 'ConditionalCheckFailedException';
}
function isTransactionCanceled(error) {
    return error?.name === 'TransactionCanceledException';
}
function isPreconditionFailed(error) {
    return error?.$metadata?.httpStatusCode === 412;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function extractCause(error) {
    return error instanceof Error ? error.cause : undefined;
}
//# sourceMappingURL=archive-coordination.js.map