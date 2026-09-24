# Webhook Secret — Consumer Inventory & Rotation Runbook

This document exists because a rotation on 2026-09-18 missed a known consumer (the Pi serial
forwarder), discovered only after tracing a stream of 401s back to an unrecognized IP. The
consumer list below is the single source of truth for "everywhere this secret is configured."
**Any new device or service that authenticates to the ingestion endpoint must be added here
as part of bringing it online — not discovered later.**

## Current consumers of `PARTICLE_WEBHOOK_SECRET`

| # | Consumer | Where the secret lives | Header/field used | Notes |
|---|----------|------------------------|--------------------|-------|
| 1 | Particle Cloud webhook (`Ubidots-Sensor-Hook-v1`) | Particle Console → Integrations → webhook config | Custom header `x-particle-webhook-secret` | Configured manually in the Particle Console UI |
| 2 | Local serial log forwarder (Raspberry Pi, `serial-forwarder.service`) | `/etc/serial-forwarder.env` on the Pi (`chip@serial-forwarder`), loaded via systemd `EnvironmentFile` | Same header, `x-particle-webhook-secret`, sent via `requests` in `serial_reader.py` | Runs continuously; posts to the same `/particle/log` endpoint as the Particle webhook |
| 3 | `ParticleLogIngestionFunction` (validator) | AWS Secrets Manager — `particle-fleet-operations/ingestion/particle-credentials`, key `PARTICLE_WEBHOOK_SECRET` | N/A — this is the value everything above is checked against | Resolved via CloudFormation dynamic reference at deploy time (post `WO`/PR #35); no shell env dependency |

**This is a single shared secret across all consumers as of 2026-09-18.** A per-consumer
credential redesign is tracked separately (see "Planned: per-consumer credentials" below) —
until that lands, every consumer above must be updated on every rotation, in the order
specified.

## Rotation runbook

Follow this exact order. Skipping the order, or skipping any consumer, is what caused the
2026-09-18 incident.

1. **Generate the new secret value.**
   ```bash
   openssl rand -hex 32
   ```
2. **Write it to AWS Secrets Manager first** (`particle-fleet-operations/ingestion/particle-credentials`, key `PARTICLE_WEBHOOK_SECRET`). Do not print the value to any chat, log, or shared channel — write it directly via CLI/console, or have an agent write it without echoing it back.
3. **Deploy** (`cd infra && npx cdk deploy`) so the live Lambda actually picks up the new value from Secrets Manager. Confirm via `cdk diff` beforehand that this is the only expected change.
4. **Walk the full consumer list above, in order, updating each one:**
   - [ ] Particle Console webhook header
   - [ ] `/etc/serial-forwarder.env` on the Pi (edit, then `sudo systemctl restart serial-forwarder.service`)
   - [ ] Any consumer added to this table since the last rotation
5. **Verify each consumer after updating it**, not just at the end — check CloudWatch logs for `ParticleLogIngestionFunction` and confirm each consumer's traffic is returning 200, not 401, before considering that consumer done.
6. **Update this document** if the rotation revealed a consumer that wasn't listed (as happened with the Pi on 2026-09-18) — add it permanently, don't just fix it and move on.

### Why Secrets Manager + deploy happens before updating any client

If a client (Particle, the Pi, or any future device) is updated to the new secret *before*
the Lambda is deployed with it, every real request from that client fails until the deploy
catches up — a real, avoidable outage window. Doing Secrets Manager + deploy first means the
Lambda is always ready to accept the new secret before anything is told to start sending it.

## Planned: per-consumer credentials (reduces blast radius)

A single shared secret across all consumers means any one leak (as happened 2026-09-18)
requires rotating and manually chasing down every consumer, all urgently, all at once — and
makes it impossible to tell *which* consumer is making a given request without external
correlation (in the 2026-09-18 incident, this required IP lookup + WHOIS + manual Pi
investigation to identify the Pi forwarder as the source of post-rotation 401s).

**Target design:** each consumer gets its own distinct secret/credential, validated by
`ParticleLogIngestionFunction` against a small allow-list mapping secret → consumer identity,
rather than a single shared string equality check. Concretely:

- `PARTICLE_CLOUD_WEBHOOK_SECRET` — Particle Cloud's webhook specifically
- `SERIAL_FORWARDER_SECRET` — the Pi forwarder specifically
- A naming pattern for future devices (`<DEVICE_NAME>_SECRET`), each a separate Secrets Manager entry

Benefits once implemented:
- A leak from one consumer requires rotating only that consumer's credential — the other consumers are unaffected and need no action.
- The ingestion Lambda can log which consumer authenticated a given request, turning "who is this mystery IP" into a log line instead of a manual investigation.
- A consumer can be selectively revoked (e.g., a decommissioned or compromised device) without affecting any other consumer.

This is architecture-level work (changes the ingestion Lambda's auth/validation model, the
Secrets Manager layout, and every consumer's config) and should go through a Phase 3
architecture review before implementation — not be treated as a quick patch. Tracked as a
separate work order; not yet dispatched as of this document's creation.

**Status as of 2026-09-23:** implemented. All six Particle Cloud webhooks and the Pi
serial-log forwarder are migrated to `ingest.seeinsights.com` with per-consumer credentials;
the legacy shared-secret HTTP API route is still deployed but retired from active use,
pending a 24-hour clean-traffic observation window before removal. If it's ever removed and
needs to come back, see "Legacy HTTP API Route Restoration" in `docs/operations.md`'s
Rollback Procedures section.

## Incident history

- **2026-09-18:** `PARTICLE_WEBHOOK_SECRET` and `PARTICLE_ACCESS_TOKEN` were exposed via a
  `cdk diff` output pasted into a separate chat session (not this repo's Claude Code session).
  Both credentials were rotated. Post-rotation, the Pi serial forwarder (consumer #2 above)
  continued sending the old secret, producing a stream of 401s from its public IP
  (`219.74.165.4`, SingNet residential, Singapore) that was briefly investigated as a possible
  external probe before being traced back to the Pi's own `/etc/serial-forwarder.env`, which
  had not been part of the original rotation checklist. This document was created as the
  direct remediation for that gap.

  This specific exposure vector — a `cdk diff` printing a secret's plaintext value — is now
  structurally closed for both `PARTICLE_ACCESS_TOKEN` and `PARTICLE_WEBHOOK_SECRET`. Before
  PR #35, `infra-stack.ts` set these as literal strings computed at synth time, so a `cdk diff`
  run before that change was deployed showed the actual value in its "before" state, exactly
  as happened here. Since PR #35, both are CloudFormation dynamic references resolved from
  Secrets Manager at deploy time; `cdk diff` only ever shows the Secrets Manager ARN pointer
  for these two values, never the underlying secret, no matter when it's run. This doesn't
  make secret handling foolproof — see "Planned: per-consumer credentials" above for the
  remaining shared-secret blast-radius problem — but this one exposure path specifically
  cannot recur for these two credentials.
