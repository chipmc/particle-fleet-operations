Next Steps

Immediate

Normalize schemas

Unify:

* Particle webhook payloads
* serial forwarder payloads

Target:

single canonical envelope.

⸻

Parse serial severity

Extract:

* INFO
* WARN
* ERROR

⸻

Parse reset causes

Correlate:

* watchdog
* status
* boot logs

⸻

Parse modem health

Extract:

* MODEM_HEALTH
* MODEM_POLICY
* connect failures

⸻

Near Term

Build timeline queries

Goal:

single chronological device history.

Example:

wake
connect
publish
watchdog
reboot
status
recover

⸻

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

Current token model is functional but suboptimal.

Known secrets:
- Particle API access token for device-name enrichment
- Particle webhook/shared publish secret
- Raspberry Pi to AWS ingestion secret
- future cloud-event ingestion token
- AWS SSO/operator access

Near-term:
- use 1-year Particle token to reduce operational churn
- document token creation and expiry date
- store local operator copy in `~/.particle-log-monitoring/secrets.env`

Target:
- migrate runtime secrets to AWS Secrets Manager
- keep only secret ARNs/names in Lambda environment variables
- define rotation runbooks
- avoid shared credentials across ingestion and query APIs
- validate IAM least privilege before deployment