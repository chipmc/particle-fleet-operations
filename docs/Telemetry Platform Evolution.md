# Telemetry Platform Evolution

## Purpose

This document describes the major architectural phases of the Particle Log Monitoring platform. Each phase represents a stable architectural milestone rather than an individual release.

---

# Current Status 

Current architecture: Phase 3 – Fleet Intelligence
Status: Complete and deployed
Repository status: Source reconciled with deployed infrastructure. The repository is now the authoritative source for both Lambda code and AWS infrastructure.

---

# Design Principles

1. Immutable Event History
    * Every received event is archived and indexed.
    * Event history is never modified.
2. Derived Current State
    * DeviceCurrentState is a projection derived from immutable events.
    * It may always be rebuilt from event history.
3. Best-Effort Enrichment
    * External enrichments (Particle API, future integrations) must never block ingestion.
    * Core telemetry is always preserved.
4. Canonical Event Envelope
    * All producers normalize into a common schema.
    * Consumers should never depend on producer-specific formats.
5. Infrastructure as Code
    * AWS infrastructure is defined entirely in CDK.
    * The repository is the authoritative source of truth.
6. Observability First
    * Rich logging, health indicators, and diagnostics are built into every layer.

---- 

# Phase 0 – Log Collection

## Objective

Capture Particle webhook events reliably for later analysis.

## Architecture

Particle Webhook
        │
        ▼
API Gateway
        │
        ▼
Lambda
        │
        ├── Raw Logs (S3)
        └── Event History (DynamoDB)

## Major Capabilities

- Secure webhook ingestion
- Raw event archival
- Immutable event history
- Replay capability

---

# Phase 1 – Event Normalization

## Objective

Convert heterogeneous Particle events into a canonical event model.

## Added Components

- Canonical Event Envelope
- Event classification
- Severity normalization
- Device/project identification
- Serial log parsing

## Major Capabilities

- Uniform event model
- Consistent API contracts
- Easier analytics

---

# Phase 2 – Device Intelligence

## Objective

Provide historical device diagnostics and querying.

## Added Components

- Timeline API
- Health API
- Summary API
- Anomaly API

## Major Capabilities

- Device timelines
- Historical health
- Event correlation
- Diagnostic APIs

---

# Phase 3 – Fleet Intelligence

## Objective

Transform historical telemetry into real-time fleet state.

## Added Components

- DeviceCurrentState table
- Current-state projection
- Fleet Summary API
- Fleet Offline API
- Fleet Anomalies API
- Particle API device-name enrichment

## Major Capabilities

- Live fleet state
- Fleet-wide health
- Offline detection foundation
- Device name resolution
- Operational REST APIs
- Full CDK-managed infrastructure
- Complete unit test coverage
- Source repository reconciled with deployed infrastructure

## Deliverables

- DeviceCurrentState projection
- Fleet REST endpoints
- Phase 3 parser
- Current-state storage
- Infrastructure parity
- 68 automated tests
- Reproducible deployment from source

---

# Phase 4 – Fleet Operations (Planned)

## Objective

Provide operational visibility and proactive fleet management.

### Planned Capabilities

- Fleet dashboard
- Confidence score
- Incident detection
- Advanced offline engine
- Event correlation
- Alerting
- Historical trends
- Fleet analytics


# Summary

Phase                           Theme                   Primary Outcome

Phase 0                         Data Collection         Reliable ingestion and archival

Phase 1                         Normalization           Canonical event model

Phase 2                         Device Intelligence     Historical diagnostics and APIs

Phase 3                         Fleet Intelligence      Real-time fleet state and operational APIs

Phase 4                         Fleet Operations        Dashboards, alerting, incident management