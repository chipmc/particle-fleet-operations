/**
 * Particle Log Ingestion Lambda
 *
 * Main handler for webhook ingestion from:
 * - Particle Product Webhooks
 * - Raspberry Pi Serial Forwarder
 *
 * Phase 1: Extracted from inline CDK code (exact behavior preservation)
 * Phase 2: Will add normalization and enrichment pipeline
 *
 * Architecture:
 * - Webhook auth via X-Particle-Webhook-Secret header
 * - Raw event immutable storage in S3
 * - Fast indexed retrieval via DynamoDB
 */
import { InboundEvent, LambdaResponse } from './types';
/**
 * Main Lambda handler
 *
 * Preserves exact current behavior:
 * - 401 if webhook secret missing/invalid
 * - 400 if JSON body invalid
 * - 200 on successful storage
 * - Same logging output
 */
export declare function handler(event: InboundEvent): Promise<LambdaResponse>;
//# sourceMappingURL=handler.d.ts.map