/**
 * Query Route Handler
 * 
 * Handles all GET requests for read-only telemetry query endpoints.
 * Routes requests to appropriate query handlers.
 */

import { QueryEvent, LambdaResponse } from './types';
import { successResponse, errorResponse, unauthorizedResponse, handleError } from './utils/response';
import { handleTimelineQuery } from './query/timeline';
import { handleHealthQuery } from './query/health';
import { handleSummaryQuery } from './query/summary';
import { handleAnomaliesQuery } from './query/anomalies';
import {
  handleFleetAnomaliesQuery,
  handleFleetOfflineQuery,
  handleFleetSummaryQuery,
} from './query/fleet';

/**
 * Main query route handler
 * 
 * Routes GET requests to appropriate query endpoint:
 * - GET /device/{deviceId}/timeline
 * - GET /device/{deviceId}/health
 * - GET /device/{deviceId}/summary
 * - GET /device/{deviceId}/anomalies
 * - GET /fleet/summary
 * - GET /fleet/anomalies
 * - GET /fleet/offline
 * 
 * TODO: Separate authentication model for query endpoints.
 * Currently reuses x-particle-webhook-secret for simplicity.
 * Should migrate to API keys or OAuth for read-only access.
 * 
 * @param event - API Gateway query event
 * @returns Lambda response
 */
export async function handleQuery(event: QueryEvent): Promise<LambdaResponse> {
  // ============================================================================
  // Authentication
  // ============================================================================
  // 
  // Renamed from PARTICLE_WEBHOOK_SECRET as part of the per-consumer-credentials
  // migration: this is now this value's actual, sole purpose once the legacy ingestion
  // path is retired -- see docs/security/webhook-secret-rotation-runbook.md. Same
  // underlying value, not rotated by this rename.
  //
  // TODO: Implement separate read-only authentication:
  // - API keys for programmatic access
  // - OAuth/JWT for browser dashboard
  // - Separate IAM role with DynamoDB:Query and S3:GetObject only
  //
  // This allows incremental rollout without changing webhook auth.
  // ============================================================================

  const expectedSecret = process.env.QUERY_API_SHARED_SECRET;
  const providedSecret =
    event.headers?.['x-particle-webhook-secret'] ||
    event.headers?.['X-Particle-Webhook-Secret'];

  if (!expectedSecret || providedSecret !== expectedSecret) {
    console.warn('Unauthorized query attempt', {
      path: event.rawPath,
      ip: event.requestContext.http.sourceIp,
    });
    return unauthorizedResponse('Query endpoints require authentication');
  }

  // ============================================================================
  // Route Handling
  // ============================================================================

  try {
    const path = event.rawPath || event.requestContext.http.path;
    const pathParams = event.pathParameters;
    const queryParams = event.queryStringParameters;

    // Route: GET /device/{deviceId}/timeline
    if (path.match(/^\/device\/[^\/]+\/timeline$/)) {
      const response = await handleTimelineQuery(pathParams, queryParams);
      return successResponse(response);
    }

    // Route: GET /device/{deviceId}/health
    if (path.match(/^\/device\/[^\/]+\/health$/)) {
      const response = await handleHealthQuery(pathParams, queryParams);
      return successResponse(response);
    }

    // Route: GET /device/{deviceId}/summary
    if (path.match(/^\/device\/[^\/]+\/summary$/)) {
      const response = await handleSummaryQuery(pathParams, queryParams);
      return successResponse(response);
    }

    // Route: GET /device/{deviceId}/anomalies
    if (path.match(/^\/device\/[^\/]+\/anomalies$/)) {
      const response = await handleAnomaliesQuery(pathParams, queryParams);
      return successResponse(response);
    }

    // Route: GET /fleet/summary
    if (path === '/fleet/summary') {
      const response = await handleFleetSummaryQuery(queryParams);
      return successResponse(response);
    }

    // Route: GET /fleet/anomalies
    if (path === '/fleet/anomalies') {
      const response = await handleFleetAnomaliesQuery(queryParams);
      return successResponse(response);
    }

    // Route: GET /fleet/offline
    if (path === '/fleet/offline') {
      const response = await handleFleetOfflineQuery(queryParams);
      return successResponse(response);
    }

    // No matching route
    return errorResponse(
      'not_found',
      `Query endpoint not found: ${path}`,
      404
    );
  } catch (error) {
    return handleError(error);
  }
}
