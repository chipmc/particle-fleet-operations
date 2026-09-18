import { BatchGetCommand, DeleteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
export declare const ARCHIVE_SCHEMA_VERSION = "1";
export declare const ARCHIVE_PREFIX = "dynamodb-index-archive/v1";
export declare const ARCHIVE_RETENTION_DAYS = 730;
declare const ddb: DynamoDBDocumentClient;
declare const s3: S3Client;
export interface ArchivePageRequest {
    action: 'PROCESS_PAGE';
    runId: string;
    cutoff: string;
    pageNumber: number;
    exclusiveStartKey?: Record<string, unknown> | null;
}
export interface ArchivePageResult {
    action: 'PROCESS_PAGE';
    runId: string;
    cutoff: string;
    pageNumber: number;
    nextPageNumber: number;
    lastEvaluatedKey?: Record<string, unknown>;
    complete: boolean;
    examined: number;
    eligible: number;
    copied: number;
    alreadyArchived: number;
    verified: number;
    deleted: number;
    retained: number;
    logicalBytes: number;
    compressedBytes: number;
    retryCount: number;
    shardReports: string[];
    failures: Array<{
        partition: string;
        reason: string;
    }>;
}
interface ArchiveDependencies {
    scan(input: ScanCommand['input']): Promise<{
        Items?: Record<string, unknown>[];
        LastEvaluatedKey?: Record<string, unknown>;
    }>;
    putObject(input: PutObjectCommand['input']): Promise<void>;
    getObject(input: GetObjectCommand['input']): Promise<Buffer>;
    batchGet(input: BatchGetCommand['input']): Promise<Record<string, unknown>[]>;
    deleteItem(input: DeleteCommand['input']): Promise<void>;
}
export declare function handler(request: ArchivePageRequest): Promise<ArchivePageResult>;
export declare function processArchivePage(request: ArchivePageRequest, deps?: ArchiveDependencies, env?: NodeJS.ProcessEnv): Promise<ArchivePageResult>;
export declare function canonicalSerialize(value: unknown): string;
export { ddb, s3 };
//# sourceMappingURL=archive.d.ts.map