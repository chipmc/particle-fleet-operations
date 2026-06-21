Architecture

Unified Telemetry Planes

Plane 1 — Structured telemetry

Particle Device
→ Particle Cloud
→ Product Webhook
→ AWS API Gateway
→ Lambda
→ S3
→ DynamoDB

Events:

* Ubidots-Sensor-Hook-v1

⸻

Plane 2 — Forensic cloud events

Particle Device
→ Product Webhook
→ API Gateway
→ Lambda
→ S3
→ DynamoDB

Events:

* watchdog
* status

⸻

Plane 3 — Raw serial telemetry

Particle Device
→ USB Serial
→ Raspberry Pi Forwarder
→ API Gateway
→ Lambda
→ S3
→ DynamoDB

Events:

* serialLog
* SERIAL_CONNECTED
* SERIAL_DISCONNECTED
* SERIAL_MISSING
* LOG

⸻

Storage

S3

Raw immutable archive.

Path:

particle-events/YYYY-MM-DD/{eventName}/{deviceId}/timestamp.json

⸻

DynamoDB

Fast indexed retrieval.

Partition:

deviceId

Sort:

eventTime

Purpose:

timeline reconstruction
