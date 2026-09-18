"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = handler;
const client_cloudwatch_1 = require("@aws-sdk/client-cloudwatch");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const client_s3_1 = require("@aws-sdk/client-s3");
const archive_1 = require("./archive");
const archive_coordination_1 = require("./archive-coordination");
// Orchestration only. Lock ownership, fencing, and failure reconciliation all live in
// archive-coordination.ts -- this file's job is Step-Functions-action dispatch, the
// per-page/success report writes it already owned, and the source-table schema guard.
// The S3-object lock (dynamodb-index-archive/v1/_control/historical-rewrite.lock),
// releaseLockIfOwned, failRun, and releaseFailedExecutionLock are gone entirely, not
// adapted -- they implemented the mechanism the Phase 3 redesign replaced.
const dynamo = new client_dynamodb_1.DynamoDBClient({});
const s3 = new client_s3_1.S3Client({});
const cloudWatch = new client_cloudwatch_1.CloudWatchClient({});
async function handler(request) {
    switch (request.action) {
        case 'START':
            return startRun(request.executionStartedAt, request.executionArn);
        case 'PROCESS_PAGE': {
            const coordinationTableName = requiredEnv('ARCHIVE_COORDINATION_TABLE_NAME');
            await (0, archive_coordination_1.assertLockHeld)(archive_coordination_1.dependencies, coordinationTableName, request.executionArn, request.fencingToken);
            const result = await (0, archive_1.processArchivePage)(request);
            await putJson(pageReportKey(result.runId, result.pageNumber), { ...result, recordedAt: new Date().toISOString() });
            return { ...result, fencingToken: request.fencingToken };
        }
        case 'FINALIZE':
            return finalizeRun(request.runId, request.cutoff, request.executionArn, request.fencingToken);
        case 'RECONCILE_FAILURE':
            return reconcileFailureAction(request);
    }
}
async function startRun(executionStartedAt, executionArn) {
    const tableName = requiredEnv('LOG_EVENTS_TABLE_NAME');
    const coordinationTableName = requiredEnv('ARCHIVE_COORDINATION_TABLE_NAME');
    const startedAt = new Date(executionStartedAt || Date.now());
    if (!Number.isFinite(startedAt.getTime()))
        throw new Error('Invalid archive execution start time');
    const table = await dynamo.send(new client_dynamodb_1.DescribeTableCommand({ TableName: tableName }));
    const keys = table.Table?.KeySchema || [];
    if (!keys.some(key => key.AttributeName === 'deviceId' && key.KeyType === 'HASH') ||
        !keys.some(key => key.AttributeName === 'eventTime' && key.KeyType === 'RANGE')) {
        throw new Error(`Refusing to archive unexpected table schema: ${tableName}`);
    }
    const runId = startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    const cutoff = new Date(startedAt.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { fencingToken } = await (0, archive_coordination_1.acquireLock)(archive_coordination_1.dependencies, coordinationTableName, {
        executionArn,
        runId,
        cutoff,
        sourceTableName: tableName,
        now: startedAt.getTime(),
    });
    console.info(JSON.stringify({ event: 'archive_run_started', runId, cutoff, tableName, fencingToken, deletionEnabled: false }));
    return { action: 'PROCESS_PAGE', runId, cutoff, pageNumber: 0, exclusiveStartKey: null, fencingToken };
}
async function finalizeRun(runId, cutoff, executionArn, fencingToken) {
    const coordinationTableName = requiredEnv('ARCHIVE_COORDINATION_TABLE_NAME');
    await (0, archive_coordination_1.assertLockHeld)(archive_coordination_1.dependencies, coordinationTableName, executionArn, fencingToken);
    const bucketName = requiredEnv('RAW_LOGS_BUCKET_NAME');
    const reports = await readPageReports(bucketName, runId);
    const totals = reports.reduce((sum, page) => ({
        examined: sum.examined + page.examined,
        eligible: sum.eligible + page.eligible,
        copied: sum.copied + page.copied,
        alreadyArchived: sum.alreadyArchived + page.alreadyArchived,
        verified: sum.verified + page.verified,
        deleted: sum.deleted + page.deleted,
        retained: sum.retained + page.retained,
        logicalBytes: sum.logicalBytes + page.logicalBytes,
        compressedBytes: sum.compressedBytes + page.compressedBytes,
        retryCount: sum.retryCount + page.retryCount,
    }), { examined: 0, eligible: 0, copied: 0, alreadyArchived: 0, verified: 0, deleted: 0, retained: 0, logicalBytes: 0, compressedBytes: 0, retryCount: 0 });
    const failures = reports.flatMap(page => page.failures);
    const deletionEnabled = process.env.ARCHIVE_DELETE_ENABLED === 'true';
    const status = failures.length > 0 || totals.retained > 0 || totals.verified < totals.eligible ? 'PARTIAL' : 'SUCCEEDED';
    const completedAt = new Date().toISOString();
    const report = {
        archiveSchemaVersion: '1',
        status,
        runId,
        startedAt: runId.replace(/-(\d{2})-(\d{2})Z$/, ':$1:$2Z'),
        completedAt,
        durationSeconds: Math.max(0, (Date.parse(completedAt) - Date.parse(runId.replace(/-(\d{2})-(\d{2})Z$/, ':$1:$2Z'))) / 1000),
        cutoff,
        sourceTable: requiredEnv('LOG_EVENTS_TABLE_NAME'),
        archiveBucket: bucketName,
        deletionEnabled,
        counts: {
            ...totals,
            alreadyArchived: totals.alreadyArchived,
            remainingOlderThanCutoff: totals.eligible - totals.deleted,
        },
        shardManifests: reports.flatMap(page => page.shardReports),
        failures,
        queryPath: 'DEFERRED: no Athena, restore, archive-aware API, or hot/archive union exists in this phase.',
    };
    // Success-path report key is unaffected by the coordination redesign: it was never part
    // of the two-writer race that motivated moving the FAILURE report key to
    // archive-coordination.ts's sha256(executionArn) scheme. Only one path ever reaches here.
    const reportKey = `${archive_1.ARCHIVE_PREFIX}/reports/${runId.slice(0, 4)}/${runId.slice(5, 7)}/${runId}.json`;
    await putJson(reportKey, report);
    await cloudWatch.send(new client_cloudwatch_1.PutMetricDataCommand({
        Namespace: 'ParticleFleetOperations/Archive',
        MetricData: [
            { MetricName: 'RunCompleted', Value: 1, Unit: 'Count' },
            { MetricName: 'RowsVerified', Value: totals.verified, Unit: 'Count' },
            { MetricName: 'RowsRetained', Value: totals.retained, Unit: 'Count' },
        ],
    }));
    await (0, archive_coordination_1.releaseLock)(archive_coordination_1.dependencies, coordinationTableName, executionArn, fencingToken);
    console.info(JSON.stringify({ event: 'archive_run_complete', status, reportKey, ...totals }));
    return {
        status,
        reportKey,
        subject: `[Particle archive] ${status} ${runId}`,
        message: JSON.stringify({ status, runId, cutoff, reportKey, counts: report.counts, failures }, null, 2),
    };
}
async function reconcileFailureAction(request) {
    const coordinationTableName = requiredEnv('ARCHIVE_COORDINATION_TABLE_NAME');
    const bucketName = requiredEnv('RAW_LOGS_BUCKET_NAME');
    const topicArn = requiredEnv('ARCHIVE_NOTIFICATION_TOPIC_ARN');
    // The in-workflow Catch path (context/error, no executionStartedAt) is happening right
    // now, in this same invocation -- Date.now() is the correct "now" for it. The EventBridge
    // path supplies its own executionStartedAt (the failed execution's start time, epoch
    // millis, from $.detail.startDate) and takes precedence when present.
    const now = typeof request.executionStartedAt === 'number' ? request.executionStartedAt : Date.now();
    const result = await (0, archive_coordination_1.reconcileFailure)(archive_coordination_1.dependencies, {
        tableName: coordinationTableName,
        bucketName,
        topicArn,
        executionArn: request.executionArn,
        runId: request.context?.runId,
        cutoff: request.context?.cutoff,
        status: request.status,
        error: normalizeCatchError(request.error),
        now,
    });
    // REPORT_CONFLICT means the frozen report body doesn't match what's already sitting at
    // its S3 key -- a genuine anomaly, not routine backoff. Throwing here (rather than
    // returning normally) makes this invocation itself fail, which is what feeds the
    // reconciliation DLQ/alarm below and makes it operator-visible instead of silently
    // "succeeding". CLAIM_HELD_ELSEWHERE is deliberately NOT thrown on: every archive
    // failure fires both the in-workflow Catch and this EventBridge rule, so one of the two
    // seeing CLAIM_HELD_ELSEWHERE is the expected, common shape of a normal failure, not an
    // error -- throwing on it would alarm on every single archive failure. See
    // "Archive Coordination Lock and Fencing" / Finding 4 in docs/architecture.md for the
    // residual gap this leaves (a claim holder that crashes before finishing, with the other
    // caller already past CLAIM_HELD_ELSEWHERE) and why closing it is out of scope here.
    if (result.outcome === 'REPORT_CONFLICT') {
        throw new Error(`Archive failure report conflict for ${request.executionArn} at ${result.reportKey}: a different report body already exists at that key.`);
    }
    return { ...result };
}
// The ASL Catch clause supplies a plain `{ Error, Cause }` object (both strings), never a
// JS Error instance -- passing it straight through made errorMessage()/extractCause() in
// archive-coordination.ts (which check `instanceof Error`) fall through to `String(error)`,
// permanently freezing "[object Object]" with no cause into the failure evidence the very
// first time a report is written. Reconstructing a real Error here, with Cause preserved
// as its `cause`, is what makes that evidence useful.
function normalizeCatchError(raw) {
    if (raw === undefined)
        return undefined;
    if (raw instanceof Error)
        return raw;
    if (typeof raw === 'object' && raw !== null) {
        const { Error: name, Cause: cause } = raw;
        const error = new Error(typeof name === 'string' ? name : JSON.stringify(raw));
        error.cause = cause;
        return error;
    }
    return new Error(String(raw));
}
async function readPageReports(bucketName, runId) {
    const prefix = `${archive_1.ARCHIVE_PREFIX}/runs/${runId}/pages/`;
    const reports = [];
    let continuationToken;
    do {
        const listed = await s3.send(new client_s3_1.ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, ContinuationToken: continuationToken }));
        for (const object of listed.Contents || []) {
            if (!object.Key)
                continue;
            const response = await s3.send(new client_s3_1.GetObjectCommand({ Bucket: bucketName, Key: object.Key }));
            if (!response.Body)
                throw new Error(`Page report is empty: ${object.Key}`);
            reports.push(JSON.parse(await response.Body.transformToString()));
        }
        continuationToken = listed.NextContinuationToken;
    } while (continuationToken);
    return reports.sort((left, right) => left.pageNumber - right.pageNumber);
}
async function putJson(key, value) {
    await s3.send(new client_s3_1.PutObjectCommand({
        Bucket: requiredEnv('RAW_LOGS_BUCKET_NAME'),
        Key: key,
        Body: (0, archive_1.canonicalSerialize)((0, archive_coordination_1.omitUndefinedObjectProperties)(value)),
        ContentType: 'application/json',
    }));
}
function pageReportKey(runId, pageNumber) {
    return `${archive_1.ARCHIVE_PREFIX}/runs/${runId}/pages/page-${String(pageNumber).padStart(5, '0')}.json`;
}
function requiredEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing required environment variable: ${name}`);
    return value;
}
//# sourceMappingURL=archive-control.js.map