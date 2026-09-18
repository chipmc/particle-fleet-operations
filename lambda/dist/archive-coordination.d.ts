export declare const COORDINATION_LOCK_PK = "LOCK#monthly-archive";
export declare const COORDINATION_SK = "METADATA";
export declare const LOCK_LEASE_HOURS = 24;
export declare const RUN_ITEM_TTL_DAYS = 90;
export declare const CLAIM_LEASE_MINUTES = 5;
export declare class LockHeldError extends Error {
}
export declare class LockFencingError extends Error {
}
export declare class ReportConflictError extends Error {
}
export declare function runItemKey(executionArn: string): {
    PK: string;
    SK: string;
};
export declare function reportKeyFor(executionArn: string, now: number): string;
export declare function omitUndefinedObjectProperties(value: unknown): unknown;
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
    getItem(params: {
        TableName: string;
        Key: Record<string, unknown>;
        ConsistentRead?: boolean;
    }): Promise<Record<string, unknown> | undefined>;
    putItem(params: {
        TableName: string;
        Item: Record<string, unknown>;
        ConditionExpression?: string;
    }): Promise<void>;
    updateItem(params: {
        TableName: string;
        Key: Record<string, unknown>;
        UpdateExpression: string;
        ConditionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
    }): Promise<void>;
    transactWrite(params: {
        TableName: string;
        items: TransactItem[];
    }): Promise<void>;
    putObject(params: {
        Bucket: string;
        Key: string;
        Body: Buffer;
        ContentType: string;
        IfNoneMatch?: string;
    }): Promise<void>;
    getObject(params: {
        Bucket: string;
        Key: string;
    }): Promise<Buffer>;
    publish(params: {
        TopicArn: string;
        Subject: string;
        Message: string;
    }): Promise<{
        messageId?: string;
    }>;
    describeExecution(executionArn: string): Promise<{
        status?: string;
        startDate?: Date;
        stopDate?: Date;
        error?: string;
        cause?: string;
    } | undefined>;
    now(): number;
}
export interface TransactItem {
    update?: {
        Key: Record<string, unknown>;
        UpdateExpression: string;
        ConditionExpression: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
    };
    put?: {
        Item: Record<string, unknown>;
        ConditionExpression: string;
    };
}
export declare const dependencies: CoordinationDependencies;
export interface AcquireLockInput {
    executionArn: string;
    runId: string;
    cutoff: string;
    sourceTableName: string;
    now: number;
    leaseHours?: number;
}
export declare function acquireLock(deps: CoordinationDependencies, tableName: string, input: AcquireLockInput): Promise<{
    fencingToken: number;
}>;
export declare function assertLockHeld(deps: CoordinationDependencies, tableName: string, executionArn: string, fencingToken: number): Promise<void>;
export declare function releaseLock(deps: CoordinationDependencies, tableName: string, executionArn: string, fencingToken: number): Promise<{
    released: boolean;
    reason?: string;
}>;
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
export declare function reconcileFailure(deps: CoordinationDependencies, input: ReconcileFailureInput): Promise<ReconcileResult>;
//# sourceMappingURL=archive-coordination.d.ts.map