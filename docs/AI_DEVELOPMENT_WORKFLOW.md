AI Development Workflow

Purpose

This document defines how AI tools are used within the Particle Log Monitoring / Unified Telemetry project.

The goal is to maximize reliability and maintainability while minimizing field risk.

⸻

Roles

Chip (Chief Engineer)

Responsibilities:

* Final technical authority
* Release approval
* Priority setting
* Acceptance of architectural changes
* Determination of production readiness
* Chatty may propose implementation patterns and review diffs, but should not author large repo changes unless explicitly requested by Chip.

No AI agent may be considered the final approver of a change.

⸻

Chatty — Observability Architect

Responsibilities:

* telemetry architecture
* canonical schema design
* event normalization strategy
* DynamoDB access-pattern design
* Lambda enrichment strategy
* S3 replay model
* AI diagnostics roadmap
* operational risk review

I should not be the primary repo investigator or AWS command runner. I should review evidence from CODEX / AWS agent / Claude and guide the design.

⸻

CODEX (Repository Investigator)

Responsibilities:

* Static analysis
* Code archaeology
* Dependency analysis
* Call graph analysis
* Complexity analysis
* Architectural compliance audits

CODEX should gather evidence and provide findings.

CODEX should avoid implementing significant code changes without architectural review.

Typical tasks:

* Identify extraction candidates
* Find architectural violations
* Locate dead code
* Measure complexity
* Trace dependencies

⸻

Claude (Implementation Engineer)

Responsibilities:

* Implement approved designs
* Perform refactoring
* Create pull requests
* Update documentation
* Remove temporary diagnostics

Claude should implement agreed architecture rather than invent new architecture.

⸻

AWS Agent / Infrastructure Executor

Responsibilities:

* inspect deployed AWS resources
* compare CDK intent vs deployed CloudFormation state
* validate IAM policies
* validate API Gateway/Lambda/S3/DynamoDB wiring
* run AWS CLI checks
* review CloudWatch logs
* confirm deployment diffs before apply

Important boundary:

The AWS agent may investigate and validate deployed infrastructure, but should not deploy destructive changes or modify IAM/security posture without Chip approval.

⸻

GitHub Copilot

Responsibilities:

* Large-scale mechanical refactoring
* Repository-wide transformations
* Namespace cleanup
* Include cleanup
* File reorganization

GitHub Copilot should not make architecture-sensitive changes without prior review.

⸻

Standard Workflow

Phase 1 — Repository Investigation

CODEX reviews particle-log-monitoring and local-serial-log-forwarder.

Phase 2 — Deployed AWS Investigation

AWS Agent reviews API Gateway, Lambda, S3, DynamoDB, CloudWatch, IAM, and CDK/CloudFormation state.

Phase 3 — Architecture Review

Chatty reviews evidence and proposes schema, normalization, enrichment, and timeline model.

Phase 4 — Implementation

Claude implements approved changes in repo branches.

Every proposed change should be classified as:
- additive
- refactor-only
- behavior-changing
- contract-changing
- security-sensitive
- infrastructure-sensitive

Security Gate — Required Before Deployment
- no plaintext secrets
- no unexpected IAM broadening
- no public data exposure
- no contract-breaking API/schema change
- no destructive data operation

Phase 5 — Deployment Review

AWS Agent shows CDK diff / CloudFormation impact before deployment.

Phase 6 — Validation

Chip validates behavior using AWS logs, S3, DynamoDB queries, and Pi/device soak logs.

Phase 7 — Cleanup / Documentation

Claude updates README, architecture docs, runbooks, and removes temporary diagnostics.

⸻

Engineering Principles

When tradeoffs exist:

1. Prefer simpler solutions.
2. Prefer proven solutions.
3. Prefer maintainability over cleverness.
4. Prefer reliability over new features.
5. Prefer evidence over assumptions.

All investigation findings should include:
- files/resources inspected
- evidence observed
- risk level
- recommendation
- confidence level

⸻

When investigating discrepancies:

1. Deployed AWS state (CloudFormation, Lambda, DynamoDB, API Gateway)
2. Generated deployment artifacts (cdk.out, Lambda bundles)
3. Tracked source code
4. Build output
5. Assumptions

If these disagree:

Do not implement until the discrepancy is understood.

Repository and deployment are both authoritative sources of evidence.

⸻

Architect

* Defines the problem.
* Approves the design.
* Produces implementation prompt.

Investigator

* No code changes.
* Evidence only.
* Contract verification.
* Identifies risks.
* Recommends implementation.

Implementor

* Changes only approved files.
* Never broadens scope.
* Always runs validation.
* Reports exactly what changed.
* Never invents architecture.

--- 

Current Project Focus

Current priorities:
Current Project Focus

1. Stabilize Particle device-name enrichment.
2. Verify current-state projection correctness.
3. Preserve no-scan fleet API design.
4. Prepare additive Ubidots cloud event plane.
5. Harden secrets with AWS Secrets Manager.
