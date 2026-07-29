# Engineering Handover – Secrets Management and Deployment

## Executive Summary

Particle Fleet Operations deliberately separates **secret lifecycle management** from **application deployment**.

The repository never stores, generates, rotates, or caches production credentials.

Instead:

- an external operations utility owns credential rotation,
- a local operator cache provides deployment-time credentials,
- CDK consumes those credentials via environment variables,
- deployed AWS infrastructure receives the values during deployment.

This separation minimizes accidental credential exposure while allowing credentials to be rotated independently of application code.

---

# Architectural Principle

There are three distinct responsibilities.

```text
Credential Lifecycle
        │
        ▼
Operations Utility
        │
        ▼
Local Secret Cache
        │
        ▼
Deployment (CDK)
        │
        ▼
AWS Infrastructure
```

The Fleet Operations repository owns only the final step.

It never owns credential generation or rotation.

---

# Design Goals

The architecture was designed to achieve the following:

- No secrets committed to Git.
- No secrets embedded in source code.
- No secrets embedded in documentation.
- Credentials can be rotated independently of deployments.
- Deployment consumes locally validated credentials.
- Production receives only the currently approved credentials.

---

# Secret Lifecycle

The lifecycle is intentionally divided into two phases.

## Phase 1 – Credential Rotation

An external operations utility manages Particle credentials.

Current utility:

```text
~/Documents/Maker/Particle/ops/ParticleTokenRotation.sh
```

Responsibilities:

- Generate replacement Particle token.
- Request one-year token lifetime.
- Validate authentication.
- Validate access to the required Ledger.
- Atomically replace the local cache.
- Preserve the previous cache if validation fails.
- Never expose token values.

This utility exists outside the Fleet Operations repository by design.

---

## Phase 2 – Deployment

Deployment does **not** create credentials.

Deployment simply consumes the current locally cached secrets.

The deployment shell loads the local cache into the environment before CDK is executed.

Conceptually:

```bash
source ~/.particle-log-monitoring/secrets.env

cd infra

npx cdk deploy
```

Deployment therefore always uses the latest locally validated credentials.

---

# Local Secret Cache

The canonical local cache is:

```text
~/.particle-log-monitoring/secrets.env
```

Characteristics:

- local only
- never committed
- never synchronized
- mode 600
- atomically updated
- managed exclusively by the rotation utility

Fleet Operations should treat this file as read-only.

---

# Expected Environment Variables

The deployment environment should contain the required deployment credentials.

Examples include:

```bash
PARTICLE_ACCESS_TOKEN
PARTICLE_WEBHOOK_SECRET
```

Additional deployment credentials may be added over time.

Deployment tooling should validate that all required variables are present before beginning deployment.

---

# Deployment Flow

The intended deployment workflow is:

```text
Rotate credentials (if required)

↓

Validate new credentials

↓

Update local secret cache

↓

Source local secret cache

↓

Deploy via CDK

↓

Validate deployed Lambda

↓

Revoke previous credential (if rotating)
```

The deployment process must never revoke the previous credential before the deployed Lambda has been successfully validated.

---

# Why Secrets Are External

The repository intentionally does **not** contain:

- `.env`
- deployment secrets
- generated tokens
- webhook secrets
- AWS credentials

This avoids:

- accidental Git commits
- secret scanning alerts
- AI exposure
- documentation leaks
- shell history leaks

The repository should remain deployable without containing any production credentials.

---

# Separation of Responsibilities

## Operations Utility

Owns:

- credential creation
- credential rotation
- validation
- cache updates
- cache integrity

Does not deploy application code.

---

## Fleet Operations Repository

Owns:

- infrastructure
- Lambda code
- CDK stacks
- deployment

Does not generate or rotate credentials.

---

## AWS

Receives:

- validated credentials
- infrastructure updates

Does not know how credentials were created.

---

# Future Deployment Helper

The repository currently uses direct CDK deployment.

A future `tools/deploy` helper should automate the deployment workflow without changing the architectural separation.

Recommended responsibilities:

1. Verify clean Git status.
2. Verify current branch.
3. Source `~/.particle-log-monitoring/secrets.env`.
4. Verify all required environment variables are present.
5. Display the deployment target.
6. Run `cdk diff`.
7. Request operator confirmation.
8. Execute `npx cdk deploy`.
9. Run post-deployment validation.
10. Display deployment summary.

Importantly, the helper should **consume** the local cache but **never** generate or modify secrets.

---

# Security Principles

The deployment process must never:

- create credentials,
- rotate credentials,
- write secret files,
- cache credentials elsewhere,
- log credential values,
- display credential values,
- commit credential material,
- embed secrets into source code.

Deployment is a consumer of secrets, never their owner.

---

# Operator Workflow

The complete operational workflow is:

```text
Need new credential?

        │
        ▼

Run ParticleTokenRotation.sh

        │
        ▼

Local cache updated

        │
        ▼

Open deployment shell

        │
        ▼

source ~/.particle-log-monitoring/secrets.env

        │
        ▼

cd infra

        │
        ▼

npx cdk deploy

        │
        ▼

Validate deployed Lambda

        │
        ▼

Revoke previous token (if applicable)
```

---

# Architectural Principle

Credential management and application deployment are intentionally decoupled.

The external operations utility owns the credential lifecycle. The local secret cache provides validated deployment inputs. Fleet Operations consumes those inputs during deployment and never assumes responsibility for generating, rotating, or persisting secrets. This separation reduces operational risk, supports safe credential rotation, and keeps sensitive material outside the application repository.
