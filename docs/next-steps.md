Next Steps

Items that have shipped are listed under Done at the end, with the evidence checked.

Immediate

Parse reset causes

Correlate:

* watchdog
* status
* boot logs

Status (checked 2026-09-29): partial. Ingestion sets resetDetected and watchdogDetected flags and a reset/watchdog category from serial lines, but parseResetCause in lambda/src/utils/parse.ts is still a stub that returns null. Watchdog breadcrumbs can be decoded offline with tools/breadcrumb-decode.js.

⸻

Parse modem health

Extract:

* MODEM_HEALTH
* MODEM_POLICY
* connect failures

Status (checked 2026-09-29): partial. Serial lines mentioning modem, ncp, cellular or sim get the category "modem"; no MODEM_HEALTH or MODEM_POLICY fields are extracted.

⸻

Near Term

Add operational dashboards

Potential:

* CloudWatch
* QuickSight
* Grafana

⸻

Medium Term

OpenClaw diagnostic agent

Data sources:

* S3
* DynamoDB

Use cases:

* soak diagnostics
* watchdog root cause analysis
* modem instability
* fleet anomaly detection

## Security Hardening: Secrets Management

Known secrets:
- Particle API access token for device-name enrichment
- Per-consumer ingestion credentials (webhook secret + API key) for the Particle Cloud
  webhooks and the Pi serial forwarder, since 2026-09-24
- Query API shared secret
- future cloud-event ingestion token
- AWS SSO/operator access

Open:
- document the current Particle token's creation and expiry date (the 1-year lifetime is
  documented in docs/security/secrets-management.md, but no date is recorded)
- keep only secret ARNs/names in Lambda environment variables. Done for the per-consumer
  secrets, which the Lambda reads by name at runtime. Not done for PARTICLE_ACCESS_TOKEN and
  QUERY_API_SHARED_SECRET: CloudFormation resolves them from Secrets Manager at deploy time
  into the Lambda's environment as values (infra/lib/infra-stack.ts).
- define rotation runbooks. The webhook secret runbook exists; the API key rotation procedure
  is written but blocked on a prerequisite (docs/security/webhook-secret-rotation-runbook.md).
- validate IAM least privilege before deployment (not checked 2026-09-29)

Model routing (2026-10-08): docs/AI_DEVELOPMENT_WORKFLOW.md has no model-routing section like the firmware's section 5 (per-role defaults, escalation, Codex/Copilot commands), which rule (e) builds on; add one in its own WO.

⸻

Done

Checked against main on 2026-09-29.

* Normalize schemas into a single canonical envelope: Phase 2A. Every event, from Particle
  webhooks and the serial forwarder, passes through normalizeEvent in the ingestion Lambda
  (lambda/src/ingestion.ts). Contract: docs/contracts/canonical-event-envelope.md. First
  shipped 2026-06-26 (ed24c46).
* Parse serial severity: parseSeverity extracts TRACE, INFO, WARN and ERROR into the
  severity field (lambda/src/utils/parse.ts). Shipped 2026-06-26 (ed24c46).
* Build timeline queries: GET /device/{deviceId}/timeline (2026-07-01, bc407a7) and the
  telemetry timeline command (2026-07-13, 44b3f5f).
* Migrate runtime secrets to AWS Secrets Manager: PR #35 (2026-09-18), plus per-consumer
  secrets in PR #39 (2026-09-24).
* Avoid shared credentials across ingestion and query APIs: since the legacy ingestion route
  was removed on 2026-09-24 (PR #39), ingestion accepts only per-consumer credentials and
  QUERY_API_SHARED_SECRET is used only by the query API. Its value was carried over from the
  old PARTICLE_WEBHOOK_SECRET, not rotated.
* Use a 1-year Particle token and keep a local operator copy in
  ~/.particle-log-monitoring/secrets.env: documented in docs/security/secrets-management.md.
