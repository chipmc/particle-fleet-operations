"use strict";
/**
 * Query Route Handler
 *
 * Handles all GET requests for read-only telemetry query endpoints.
 * Routes requests to appropriate query handlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleQuery = handleQuery;
const response_1 = require("./utils/response");
const timeline_1 = require("./query/timeline");
const health_1 = require("./query/health");
const summary_1 = require("./query/summary");
const anomalies_1 = require("./query/anomalies");
const fleet_1 = require("./query/fleet");
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
async function handleQuery(event) {
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
    const providedSecret = event.headers?.['x-particle-webhook-secret'] ||
        event.headers?.['X-Particle-Webhook-Secret'];
    if (!expectedSecret || providedSecret !== expectedSecret) {
        console.warn('Unauthorized query attempt', {
            path: event.rawPath,
            ip: event.requestContext.http.sourceIp,
        });
        return (0, response_1.unauthorizedResponse)('Query endpoints require authentication');
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
            const response = await (0, timeline_1.handleTimelineQuery)(pathParams, queryParams);
            return (0, response_1.successResponse)(response);
        }
        // Route: GET /device/{deviceId}/health
        if (path.match(/^\/device\/[^\/]+\/health$/)) {
            const response = await (0, health_1.handleHealthQuery)(pathParams, queryParams);
            return (0, response_1.successResponse)(response);
        }
        // Route: GET /device/{deviceId}/summary
        if (path.match(/^\/device\/[^\/]+\/summary$/)) {
            const response = await (0, summary_1.handleSummaryQuery)(pathParams, queryParams);
            return (0, response_1.successResponse)(response);
        }
        // Route: GET /device/{deviceId}/anomalies
        if (path.match(/^\/device\/[^\/]+\/anomalies$/)) {
            const response = await (0, anomalies_1.handleAnomaliesQuery)(pathParams, queryParams);
            return (0, response_1.successResponse)(response);
        }
        // Route: GET /fleet/summary
        if (path === '/fleet/summary') {
            const response = await (0, fleet_1.handleFleetSummaryQuery)(queryParams);
            return (0, response_1.successResponse)(response);
        }
        // Route: GET /fleet/anomalies
        if (path === '/fleet/anomalies') {
            const response = await (0, fleet_1.handleFleetAnomaliesQuery)(queryParams);
            return (0, response_1.successResponse)(response);
        }
        // Route: GET /fleet/offline
        if (path === '/fleet/offline') {
            const response = await (0, fleet_1.handleFleetOfflineQuery)(queryParams);
            return (0, response_1.successResponse)(response);
        }
        // No matching route
        return (0, response_1.errorResponse)('not_found', `Query endpoint not found: ${path}`, 404);
    }
    catch (error) {
        return (0, response_1.handleError)(error);
    }
}
//# sourceMappingURL=query.js.map