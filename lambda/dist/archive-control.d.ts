import { ArchivePageRequest } from './archive';
type ArchiveControlRequest = {
    action: 'START';
    executionStartedAt?: string;
    executionArn: string;
} | (ArchivePageRequest & {
    executionArn: string;
    fencingToken: number;
}) | {
    action: 'FINALIZE';
    runId: string;
    cutoff: string;
    executionArn: string;
    fencingToken: number;
} | {
    action: 'RECONCILE_FAILURE';
    executionArn: string;
    context?: {
        runId?: string;
        cutoff?: string;
    };
    error?: unknown;
    executionStartedAt?: number;
    status?: string;
};
export declare function handler(request: ArchiveControlRequest): Promise<Record<string, unknown>>;
export {};
//# sourceMappingURL=archive-control.d.ts.map