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

CODEX reviews particle-fleet-operations and local-serial-log-forwarder.

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

Also update docs/STYLE_GUIDE.md whenever a round surfaced a convention that was not
written down. The guide's own maintenance rule is that "we had to rediscover this" is the
trigger to add a line, not just to fix the immediate instance. A work order that produced
a new rule is not finished until the rule is in the guide.

⸻

Engineering Principles

Style & Usage Guide

docs/STYLE_GUIDE.md is binding on every change to this repository, by any agent or by
Chip. Read it before writing code, and again before opening a PR. Its rules are not
stylistic preferences; almost every one is a defect that already happened here, written
down so it does not have to be rediscovered. Sections 3, 4 and 5 in particular encode
failure modes that a green test suite did not catch.

A change that violates it is not merely untidy. Treat a violation the way you would treat
a failing test: fix it, or state explicitly in the PR why the rule does not apply here.

When the guide and docs/API.md disagree, docs/API.md is authoritative and the guide is the
file to correct. When the guide and this document disagree on process, say so rather than
picking one silently.

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

Verification Fixtures

Fixture parameters are specified by the reviewer, not the implementer.

For any work order whose verification depends on dataset shape, the reviewer specifies —
before implementation begins — the dataset sizes, the counts of rows deliberately placed
outside the window, the timestamp encodings present, the limit values, and the expected
row counts and identities. An implementer may add cases. An implementer may not narrow,
resize, or re-encode a specified one. A bound that has to be widened to make a test pass
is a finding to report, not an edit to make.

This is a structural rule, not a matter of diligence. Across WO-2026-08-28-004 three
separate verification fixtures, each chosen by whoever wrote the code under test, were too
small or too favourable to reach the defect they were written to catch:

* A four-cell dense-window test used four out-of-window rows where the defect needed
  roughly two thousand. It passed while one transport returned zero of six matching rows.
* A query-count bound was doubled to accommodate the implementation, concealing a scan
  budget running at roughly twice its intended size.
* A boundary test used a row pair in an encoding where the defect does not reproduce, so
  it passed against the code that contained it.

Two of those three were written by the reviewer, not the implementer. Whoever knows how
the code works tends to pick parameters it handles, and that bias does not respond to
being more careful. Separating who sets the parameters from who writes the code removes
it.

Related: any test harness or mock standing in for a real service must be cross-checked
against that service before its results are used as evidence. A mock that modelled
DynamoDB ExclusiveStartKey as a positional offset rather than a key produced two false
blocking defect reports across two review rounds before the discrepancy was noticed.

The full set of testing rules this project has accumulated — including this one, the
requirement that a new test be shown to fail for the correct reason, and the rule against
loosening an assertion to accommodate new code — is in docs/STYLE_GUIDE.md section 5.
Its section 3 carries the DynamoDB and timestamp-encoding conventions that a mock has to
respect to be evidence at all.

⸻

Current Project Focus

Current priorities:
Current Project Focus

1. Stabilize Particle device-name enrichment.
2. Verify current-state projection correctness.
3. Preserve no-scan fleet API design.
4. Prepare additive Ubidots cloud event plane.
5. Harden secrets with AWS Secrets Manager.
