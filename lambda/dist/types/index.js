"use strict";
/**
 * Type definitions for Particle log ingestion Lambda
 *
 * Phase 1: Current schema (preserved exactly)
 * Phase 2: Will add CanonicalEvent types from canonical-event-envelope.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
// ============================================================================
// Phase 2 Types (Not Used Yet)
// ============================================================================
/**
 * Canonical event envelope
 * From: docs/contracts/canonical-event-envelope.md
 *
 * This will be implemented in Phase 2 - Normalization
 * Keeping type definition here for future reference
 */
/*
export interface CanonicalEvent {
  schemaVersion: string;
  eventId: string;
  projectId: string;
  deviceId: string;
  deviceName: string | null;
  eventTime: string;
  ingestTime: string;
  isSyntheticTime: boolean;
  plane: 'telemetry' | 'forensic' | 'serial';
  eventType: string;
  eventVersion: string;
  eventName: string;
  sourceType: string;
  collectorId: string | null;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'TRACE' | null;
  resetCause: string | null;
  networkState: string | null;
  queueDepth: number | null;
  payload: Record<string, any>;
  rawRef: {
    s3Key: string;
  };
}
*/
//# sourceMappingURL=index.js.map