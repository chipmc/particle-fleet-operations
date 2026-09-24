/**
 * Particle Log Monitoring Lambda - Main Handler
 * 
 * Routes requests between ingestion and query handlers:
 * - POST /particle/log → Ingestion (Phase 1 + 2A)
 * - GET /device/... → Query API (Phase 2B)
 * 
 * Phase 1: Extracted from inline CDK code (exact behavior preservation)
 * Phase 2A: Additive normalization and enrichment pipeline
 * Phase 2B: Read-only query API for browser/API observability
 */

import { InboundEvent, QueryEvent, RestApiProxyEvent, LambdaResponse } from './types';
import { handleIngestion } from './ingestion';
import { handleQuery } from './query';

/**
 * Main Lambda handler - Route dispatcher
 *
 * Preserves exact ingestion behavior for POST /particle/log.
 * Adds new GET endpoints for telemetry queries.
 *
 * Accepts:
 * - InboundEvent (simple POST with body/headers only) - for backward compat
 * - QueryEvent (HTTP API v2 format) - the legacy ingestion route and every query route
 * - RestApiProxyEvent (REST API v1 format) - the ingestion custom domain
 *   (ingest.seeinsights.com), adapted into InboundEvent below before reaching
 *   handleIngestion -- this is purely an integration-envelope adaptation (what API
 *   Gateway hands the Lambda), not a change to the webhook payload or HTTP response
 *   either caller actually sees.
 *
 * @param event - API Gateway event (HTTP API v2, REST API v1, or legacy format)
 * @returns Lambda response
 */
export async function handler(event: InboundEvent | QueryEvent | RestApiProxyEvent): Promise<LambdaResponse> {
  // Detect event format and extract HTTP method
  // HTTP API v2 uses requestContext.http.method and has version/routeKey fields.
  // REST API v1 uses a top-level httpMethod field and requestContext.identity instead.
  let method: string;
  let path: string;

  const isQueryEvent = (evt: InboundEvent | QueryEvent | RestApiProxyEvent): evt is QueryEvent => {
    return 'version' in evt && 'routeKey' in evt && 'requestContext' in evt;
  };
  const isRestApiProxyEvent = (evt: InboundEvent | QueryEvent | RestApiProxyEvent): evt is RestApiProxyEvent => {
    return 'httpMethod' in evt && 'requestContext' in evt && 'identity' in (evt as RestApiProxyEvent).requestContext;
  };

  let adaptedEvent: InboundEvent | QueryEvent = event as InboundEvent | QueryEvent;

  if (isQueryEvent(event)) {
    // HTTP API v2 format (legacy ingestion route + every query route)
    method = event.requestContext.http.method;
    path = event.requestContext.http.path;
  } else if (isRestApiProxyEvent(event)) {
    // REST API v1 format (ingestion custom domain). Adapted into the same InboundEvent
    // shape the legacy path already uses -- apiKeyId is the one new field, populated
    // only here, and is what tells ingestion.ts to use the per-consumer validation path
    // (consumer-auth.ts) instead of the legacy shared-secret check.
    method = event.httpMethod;
    path = event.path;
    adaptedEvent = {
      body: event.body ?? undefined,
      headers: event.headers ?? {},
      requestContext: {
        http: {
          userAgent: event.requestContext.identity.userAgent ?? undefined,
          sourceIp: event.requestContext.identity.sourceIp ?? undefined,
        },
      },
      apiKeyId: event.requestContext.identity.apiKeyId ?? undefined,
    };
  } else {
    // Legacy InboundEvent format (tests/backward compat)
    method = 'POST';
    path = '/particle/log';
  }

  console.log('Request:', {
    method,
    path,
    routeKey: isQueryEvent(event) ? event.routeKey : undefined,
    deviceId: isQueryEvent(event) ? event.pathParameters?.deviceId : undefined,
  });

  // Route to appropriate handler based on HTTP method
  if (method === 'POST') {
    // POST /particle/log → Ingestion (exact Phase 1 + 2A behavior on the legacy path;
    // per-consumer validation on the REST API path -- see ingestion.ts)
    return handleIngestion(adaptedEvent);
  }

  if (method === 'GET') {
    // GET /device/... → Query API (Phase 2B)
    // Must be a QueryEvent with full structure
    if (!isQueryEvent(event)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'bad_request',
          message: 'Query requests require full HTTP API v2 event structure',
        }),
      };
    }
    return handleQuery(event);
  }

  // Unsupported method
  return {
    statusCode: 405,
    body: JSON.stringify({
      error: 'method_not_allowed',
      message: `Method ${method} not allowed`,
    }),
  };
}
