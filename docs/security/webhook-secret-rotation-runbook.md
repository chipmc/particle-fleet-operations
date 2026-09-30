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
serial-log forwarder are migrated to `ingest.seeinsights.com` with per-consumer credentials.

**Legacy route removed 2026-09-24 (PR #39):** the legacy shared-secret HTTP API route
`POST /particle/log` was removed after its 24-hour clean-traffic window. Verified
2026-09-29: the route is absent from the deployed HTTP API (`dqqrzw16gk`, which keeps its
seven `GET` query routes), a POST to the old URL returns 404, and its access log
has no requests after 2026-09-23 02:37 UTC. If it needs to come back, see "Legacy HTTP API
Route Restoration" in `docs/operations.md`'s Rollback Procedures section.

## API key rotation for one consumer (no outage)

How to replace one registry consumer's API Gateway API key without dropping requests. The
consumer's webhook secret is not changed by this procedure.

**Status: blocked on a prerequisite that is not implemented.** Do not start step 2 until the
prerequisite below is deployed.

### Prerequisite: the Lambda must accept two key IDs for one consumer

`consumer-auth.ts` accepts a request only when the API key and the webhook secret belong to
the same consumer. It maps key IDs to consumers through exactly one environment variable per
consumer (`INGESTION_API_KEY_ID_<CONSUMER_ID>`, set by `infra-stack.ts`). A second key on
the same usage plan would pass API Gateway, then fail in the Lambda as
`credential_pair_mismatch` (401), because its ID maps to no consumer.

A gapless rotation therefore needs a change, not yet designed or approved, that lets:

- the registry or CDK declare a second key for one consumer, associated with the same usage
  plan; and
- the Lambda map both key IDs to that consumer for the length of the overlap.

This changes the auth path, so it goes through architecture review before implementation.

Do not rotate by renaming the existing `ApiKey` resource's logical ID. CloudFormation would
create the new key and delete the old one in the same deploy, and every client still sending
the old key would fail from that moment.

### Why this is not the AWSCURRENT/AWSPENDING pattern

That pattern is for Secrets Manager secrets, and it does not apply here for two reasons:

- An API key is not stored in Secrets Manager. API Gateway checks the key value, and the
  Lambda checks the key's ID. The overlap is simply two keys existing at the same time, both
  accepted.
- The webhook secret has no overlap mechanism today either. `consumer-auth.ts` reads each
  consumer's secret by name, which returns only its current version. Nothing reads a pending
  version. A webhook-secret rotation therefore rejects clients still sending the old value
  from the moment the new value is live until each client is updated (the Lambda caches
  secrets for up to 5 minutes, so the switch is not instant).

Overlap matters most for `particle-cloud-webhook`: one key is shared by six Particle Cloud
webhooks, and each webhook's `x-api-key` header is edited separately in the Particle Console.

### Credential handling

Never print an API key value in an agent session, a shared terminal, or a log:

- `aws apigateway get-usage-plan-keys` returns key values. Run it only with a `--query` that
  selects `id` and `name`.
- `aws apigateway get-api-key --include-value` returns the value. Only the operator runs it,
  piped straight to the clipboard, as in step 3.

Key IDs are not sensitive. Use them for every check below. See the 2026-09-28 incident entry.

### Procedure

1. **Record the current key ID.**
   ```bash
   aws apigateway get-api-keys --name-query particle-ingestion-<consumer-id> \
     --query 'items[].[id,name,enabled]' --output text
   ```
2. **Add the second key (deploy 1).** Using the prerequisite mechanism, add a new key for the
   consumer on the same usage plan and map its ID to the consumer in the Lambda. The
   `cdk diff` should show only: one new `ApiKey`, one new `UsagePlanKey`, and the Lambda
   environment change. Deploy. Then confirm both keys are on the plan, without values:
   ```bash
   aws apigateway get-usage-plan-keys --usage-plan-id <plan-id> \
     --query 'items[].[id,name]' --output text
   ```
3. **Copy the new key value (operator only).** In your own terminal, not an agent session:
   ```bash
   aws apigateway get-api-key --api-key <new-key-id> --include-value \
     --query value --output text | pbcopy
   ```
4. **Update each client, one at a time.** For `particle-cloud-webhook`, edit the `x-api-key`
   header on each of the six Particle Console webhooks. For `serial-forwarder`, update
   `AWS_API_KEY` in `/etc/serial-forwarder.env` and restart the service. Both keys are
   accepted throughout, so there is no gap between edits. After each client, confirm that
   requests with the new key ID return 200 in the access log (query in step 5, with the new
   ID). Clear the clipboard when done.
5. **Confirm the old key is no longer used.** In `IngestionRestApiAccessLogs`, over at least
   24 hours after the last client was updated (longer if any client publishes less than
   daily):
   ```
   filter apiKeyId = "<old-key-id>" | stats count(*), max(@timestamp)
   ```
   Expect no results. Also confirm the new key is working: in the ingestion Lambda's logs,
   `ingestion_auth` entries for the new key ID should show `authResult: success` and no
   failures, and each client's events should still be arriving in `ParticleLogEventsTable`.
   The six webhooks share one key, so this check cannot tell them apart. The zero count for
   the old key is what shows all six were updated.
6. **Disable the old key (deploy 2), then delete it (deploy 3).** Disable first
   (`enabled: false`) and watch for 24 hours: a client still sending it now gets 403, which
   shows in the access log. Re-enabling is the rollback at this stage. Then remove the old
   key and its ID mapping, and confirm the `cdk diff` removes only those.
7. **Update this document.** Add an incident-history entry if the rotation followed an
   exposure, and note the new key ID wherever the old one is referenced.

**Rollback before step 6:** point clients back to the old key. It stays valid until step 6.

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

- **2026-09-28:** During a read-only investigation of the serial forwarder, an
  `aws apigateway get-usage-plan-keys` call printed the API key value for the Particle Cloud
  consumer (key ID `mqdbypomt7`) into one Claude Code session: its local transcript and the
  model context for that session. It was not written, posted, or sent anywhere else.

  Assessment: low risk. The key alone cannot authenticate, because `consumer-auth.ts` also
  requires the per-consumer secret (requests without it fail as `missing_secret`,
  `invalid_secret`, or `credential_pair_mismatch`). The realistic exposure is someone spending
  that consumer's usage-plan rate limit, not reading or writing data.

  Decision: not rotated now. This departs from the exposure procedure in
  `secrets-management.md` ("Revoke the exposed credential immediately"). The reason is that
  rotating an API key means a CDK change, a deploy, and an overlap procedure this runbook does
  not yet document.

  Revisit: rotate the key at the next planned rotation, or immediately if the per-consumer
  secret is ever exposed too.
