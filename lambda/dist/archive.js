"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.s3 = exports.ddb = exports.ARCHIVE_RETENTION_DAYS = exports.ARCHIVE_PREFIX = exports.ARCHIVE_SCHEMA_VERSION = void 0;
exports.handler = handler;
exports.processArchivePage = processArchivePage;
exports.canonicalSerialize = canonicalSerialize;
const crypto_1 = require("crypto");
const zlib_1 = require("zlib");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const client_s3_1 = require("@aws-sdk/client-s3");
exports.ARCHIVE_SCHEMA_VERSION = '1';
exports.ARCHIVE_PREFIX = 'dynamodb-index-archive/v1';
exports.ARCHIVE_RETENTION_DAYS = 730;
const MAX_BATCH_GET_KEYS = 100;
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
exports.ddb = ddb;
const s3 = new client_s3_1.S3Client({});
exports.s3 = s3;
const dependencies = {
    scan: async (input) => ddb.send(new lib_dynamodb_1.ScanCommand(input)),
    putObject: async (input) => { await s3.send(new client_s3_1.PutObjectCommand(input)); },
    getObject: async (input) => {
        const response = await s3.send(new client_s3_1.GetObjectCommand(input));
        if (!response.Body)
            throw new Error('Archive read-back returned an empty body');
        return Buffer.from(await response.Body.transformToByteArray());
    },
    batchGet: async (input) => {
        const response = await ddb.send(new lib_dynamodb_1.BatchGetCommand(input));
        const tableName = Object.keys(input.RequestItems || {})[0];
        return response.Responses?.[tableName] || [];
    },
    deleteItem: async (input) => { await ddb.send(new lib_dynamodb_1.DeleteCommand(input)); },
};
async function handler(request) {
    if (request.action !== 'PROCESS_PAGE')
        throw new Error(`Unsupported archive action: ${String(request.action)}`);
    return processArchivePage(request);
}
async function processArchivePage(request, deps = dependencies, env = process.env) {
    const tableName = requiredEnv(env, 'LOG_EVENTS_TABLE_NAME');
    const bucketName = requiredEnv(env, 'RAW_LOGS_BUCKET_NAME');
    const cutoffMs = Date.parse(request.cutoff);
    if (!Number.isFinite(cutoffMs))
        throw new Error(`Invalid archive cutoff: ${request.cutoff}`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(request.runId)) {
        throw new Error(`Invalid archive run ID: ${request.runId}`);
    }
    const exclusiveStartKey = request.exclusiveStartKey && Object.keys(request.exclusiveStartKey).length > 0
        ? request.exclusiveStartKey
        : undefined;
    const page = await withRetry(() => deps.scan({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
        Limit: Number(env.ARCHIVE_SCAN_PAGE_SIZE || '250'),
        ConsistentRead: true,
    }));
    const items = page.Items || [];
    const eligible = [];
    let retained = 0;
    const selectionFailures = [];
    for (const item of items) {
        const eventTime = typeof item.eventTime === 'string' ? item.eventTime : '';
        const eventTimeMs = Date.parse(eventTime);
        if (!Number.isFinite(eventTimeMs)) {
            retained += 1;
            selectionFailures.push({ partition: 'unsharded', reason: `${sourceKeyString(item)}: invalid eventTime` });
        }
        else if (eventTimeMs < cutoffMs) {
            eligible.push(item);
        }
    }
    const grouped = groupArchiveLines(tableName, eligible);
    const shards = grouped.shards;
    retained += grouped.rejected.length;
    const shardReports = [];
    const failures = [...selectionFailures, ...grouped.rejected.map(({ item, reason }) => ({
            partition: 'unsharded',
            reason: `${sourceKeyString(item)}: ${reason}`,
        }))];
    let copied = 0;
    let alreadyArchived = 0;
    let verified = 0;
    let deleted = 0;
    let logicalBytes = 0;
    let compressedBytes = 0;
    let retryCount = 0;
    const retry = (operation) => withRetry(operation, 4, () => { retryCount += 1; });
    for (const [partition, lines] of shards) {
        try {
            const part = String(request.pageNumber).padStart(5, '0');
            const baseKey = `${exports.ARCHIVE_PREFIX}/${partition}/run_id=${request.runId}/part-${part}`;
            const dataKey = `${baseKey}.jsonl.gz`;
            const manifestKey = `${baseKey}.manifest.json`;
            const jsonl = lines.map(line => canonicalSerialize(line)).join('\n') + '\n';
            const body = (0, zlib_1.gzipSync)(jsonl);
            const checksum = sha256(body);
            const dataCreated = await putImmutableObject(deps, {
                Bucket: bucketName,
                Key: dataKey,
                Body: body,
                ContentType: 'application/x-ndjson',
                ContentEncoding: 'gzip',
                ChecksumSHA256: checksum.toString('base64'),
                IfNoneMatch: '*',
            }, body, retry);
            if (dataCreated)
                copied += lines.length;
            else
                alreadyArchived += lines.length;
            logicalBytes += Buffer.byteLength(jsonl);
            compressedBytes += body.byteLength;
            const readBack = await retry(() => deps.getObject({ Bucket: bucketName, Key: dataKey }));
            verifyArchiveObject(readBack, checksum, lines);
            const currentItems = await rereadItems(tableName, lines, deps, retry);
            const currentByKey = new Map(currentItems.map(item => [sourceKeyString(item), item]));
            const unchanged = lines.filter(line => {
                const current = currentByKey.get(sourceKeyString(line.sourceKey));
                return current !== undefined && digestItem(current) === line.itemDigest;
            });
            verified += unchanged.length;
            retained += lines.length - unchanged.length;
            if (env.ARCHIVE_DELETE_ENABLED === 'true') {
                for (const line of unchanged) {
                    await retry(() => deps.deleteItem({ TableName: tableName, Key: line.sourceKey }));
                    deleted += 1;
                }
            }
            const manifest = {
                archiveSchemaVersion: exports.ARCHIVE_SCHEMA_VERSION,
                runId: request.runId,
                cutoff: request.cutoff,
                sourceTable: tableName,
                dataKey,
                checksumSha256: checksum.toString('hex'),
                compressedBytes: body.byteLength,
                rowCount: lines.length,
                verifiedCount: unchanged.length,
                deletedCount: env.ARCHIVE_DELETE_ENABLED === 'true' ? unchanged.length : 0,
                deletionEnabled: env.ARCHIVE_DELETE_ENABLED === 'true',
                retainedKeys: lines.filter(line => !unchanged.includes(line)).map(line => line.sourceKey),
                records: lines.map(({ sourceKey, recordId, itemDigest }) => ({ sourceKey, recordId, itemDigest })),
            };
            const manifestBody = Buffer.from(canonicalSerialize(manifest));
            await putImmutableObject(deps, {
                Bucket: bucketName,
                Key: manifestKey,
                Body: manifestBody,
                ContentType: 'application/json',
                IfNoneMatch: '*',
            }, manifestBody, retry);
            shardReports.push(manifestKey);
        }
        catch (error) {
            if (error instanceof ArchiveCollisionError)
                throw error;
            retained += lines.length;
            const reason = errorMessage(error);
            failures.push({ partition, reason });
            console.error(JSON.stringify({ event: 'archive_shard_failed', runId: request.runId, partition, error: reason }));
        }
    }
    const result = {
        action: 'PROCESS_PAGE',
        runId: request.runId,
        cutoff: request.cutoff,
        pageNumber: request.pageNumber,
        nextPageNumber: request.pageNumber + 1,
        lastEvaluatedKey: page.LastEvaluatedKey,
        complete: !page.LastEvaluatedKey,
        examined: items.length,
        eligible: eligible.length,
        copied,
        alreadyArchived,
        verified,
        deleted,
        retained,
        logicalBytes,
        compressedBytes,
        retryCount,
        shardReports,
        failures,
    };
    console.info(JSON.stringify({ event: 'archive_page_complete', ...result }));
    return result;
}
function groupArchiveLines(tableName, items) {
    const shards = new Map();
    const rejected = [];
    for (const item of items) {
        try {
            if (typeof item.deviceId !== 'string' || typeof item.eventTime !== 'string') {
                throw new Error('Missing string deviceId/eventTime source key');
            }
            const line = archiveLine(tableName, item);
            const eventDate = new Date(Date.parse(item.eventTime)).toISOString().slice(0, 10);
            const deviceBucket = (0, crypto_1.createHash)('sha256').update(item.deviceId).digest('hex').slice(0, 1);
            const partition = `event_date=${eventDate}/device_bucket=${deviceBucket}`;
            const values = shards.get(partition) || [];
            values.push(line);
            shards.set(partition, values);
        }
        catch (error) {
            rejected.push({ item, reason: errorMessage(error) });
        }
    }
    return { shards, rejected };
}
function archiveLine(tableName, item) {
    const sourceKey = { deviceId: String(item.deviceId), eventTime: String(item.eventTime) };
    const itemDigest = digestItem(item);
    return {
        archiveSchemaVersion: exports.ARCHIVE_SCHEMA_VERSION,
        sourceTable: tableName,
        sourceKey,
        recordId: (0, crypto_1.createHash)('sha256').update(`${tableName}\0${sourceKey.deviceId}\0${sourceKey.eventTime}\0${itemDigest}`).digest('hex'),
        itemDigest,
        item,
    };
}
function verifyArchiveObject(readBack, expectedChecksum, expectedLines) {
    if (!sha256(readBack).equals(expectedChecksum))
        throw new Error('Archive object checksum mismatch');
    const parsed = (0, zlib_1.gunzipSync)(readBack).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (parsed.length !== expectedLines.length)
        throw new Error('Archive row-count mismatch');
    const expected = new Map(expectedLines.map(line => [sourceKeyString(line.sourceKey), line.itemDigest]));
    if (expected.size !== expectedLines.length)
        throw new Error('Archive contains duplicate source keys');
    for (const line of parsed) {
        if (line.archiveSchemaVersion !== exports.ARCHIVE_SCHEMA_VERSION)
            throw new Error('Unsupported archive schema version');
        if (expected.get(sourceKeyString(line.sourceKey)) !== line.itemDigest || digestItem(line.item) !== line.itemDigest) {
            throw new Error('Archive item digest mismatch');
        }
    }
}
async function rereadItems(tableName, lines, deps, retry) {
    const results = [];
    for (let offset = 0; offset < lines.length; offset += MAX_BATCH_GET_KEYS) {
        const keys = lines.slice(offset, offset + MAX_BATCH_GET_KEYS).map(line => line.sourceKey);
        let pending = keys;
        for (let attempt = 0; pending.length > 0 && attempt < 4; attempt += 1) {
            const items = await retry(() => deps.batchGet({ RequestItems: { [tableName]: { Keys: pending, ConsistentRead: true } } }));
            results.push(...items);
            const returned = new Set(items.map(sourceKeyString));
            pending = pending.filter(key => !returned.has(sourceKeyString(key)));
        }
    }
    return results;
}
function canonicalSerialize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new Error('Cannot archive a non-finite number');
        return JSON.stringify(value);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return canonicalSerialize({ $binary: Buffer.from(value).toString('base64') });
    }
    if (value instanceof Set) {
        return canonicalSerialize({ $set: [...value].map(item => canonicalSerialize(item)).sort() });
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalSerialize).join(',')}]`;
    if (typeof value === 'object') {
        const record = value;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`).join(',')}}`;
    }
    throw new Error(`Cannot archive value of type ${typeof value}`);
}
function digestItem(item) {
    return (0, crypto_1.createHash)('sha256').update(canonicalSerialize(item)).digest('hex');
}
function sourceKeyString(item) {
    return `${String(item.deviceId)}\0${String(item.eventTime)}`;
}
function sha256(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest();
}
async function putImmutableObject(deps, input, expectedBody, retry) {
    try {
        await retry(() => deps.putObject(input));
        return true;
    }
    catch (error) {
        if (error.$metadata?.httpStatusCode !== 412)
            throw error;
        const existing = await retry(() => deps.getObject({ Bucket: input.Bucket, Key: input.Key }));
        if (!existing.equals(expectedBody))
            throw new ArchiveCollisionError(`Archive manifest collision at ${String(input.Key)}`);
        return false;
    }
}
class ArchiveCollisionError extends Error {
}
async function withRetry(operation, attempts = 4, onRetry) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (attempt + 1 === attempts || !isTransient(error))
                throw error;
            onRetry?.();
            await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        }
    }
    throw lastError;
}
function isTransient(error) {
    const status = error?.$metadata?.httpStatusCode;
    const name = error?.name || '';
    return status === 429 || (status !== undefined && status >= 500) || /Throttl|Timeout|ServiceUnavailable|InternalServerError/.test(name);
}
function requiredEnv(env, name) {
    const value = env[name];
    if (!value)
        throw new Error(`Missing required environment variable: ${name}`);
    return value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=archive.js.map