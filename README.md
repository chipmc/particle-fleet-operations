Particle Log Monitoring

Unified telemetry ingestion platform for Particle IoT devices.

Purpose

This system captures both:

* structured device telemetry
* watchdog/reset forensic events
* raw serial runtime logs

into AWS for long-term observability and diagnostics.

⸻

Current Telemetry Sources

Particle Product Webhooks

Captures:

* occupancy
* dailyoccupancy
* battery
* temperature
* alerts
* resets
* connecttime
* watchdog
* status

⸻

Raspberry Pi Serial Forwarder

Captures:

* boot logs
* modem lifecycle
* reconnect behavior
* sleep/wake transitions
* runtime diagnostics

⸻

AWS Architecture

Particle / Pi
→ API Gateway
→ Lambda
→ S3 raw archive
→ DynamoDB indexed events

⸻

Deploy

npm install
cdk deploy

⸻

Tail Lambda Logs

AWS_PROFILE=particle-admin aws logs tail "/aws/lambda/InfraStack-ParticleLogIngestionFunctionD5193211-ckpMn4aFdjbe" --region us-east-1 --follow

⸻

Query DynamoDB

AWS_PROFILE=particle-admin aws dynamodb query \
  --table-name InfraStack-ParticleLogEventsTableF654D709-OMOORL9AXLQM \
  --key-condition-expression "deviceId = :d" \
  --expression-attribute-values '{":d":{"S":"DEVICE_ID"}}'

⸻

Current State

Working:

✓ webhook ingestion
✓ watchdog/status ingestion
✓ serial forwarder ingestion
✓ S3 storage
✓ DynamoDB indexing
✓ device timeline reconstruction

Next:

* schema normalization
* log parsing
* event correlation
* AI diagnostics