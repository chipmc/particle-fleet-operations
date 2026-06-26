Architecture

Unified Telemetry Planes

Plane 1 — Structured telemetry

Particle Device
→ Particle Cloud
→ Product Webhook
→ AWS API Gateway
→ Lambda (TypeScript)
  → Storage: S3
  → Index: DynamoDB
→ S3
→ DynamoDB

Events:

* Ubidots-Sensor-Hook-v1

⸻

Plane 2 — Forensic cloud events

Particle Device
→ Product Webhook
→ API Gateway
→ Lambda (TypeScript)
  → Storage: S3
  → Index: DynamoDB
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
→ Lambda (TypeScript)
  → Storage: S3
  → Index: DynamoDB
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

⸻

Lambda Architecture

Modular TypeScript implementation:

```
lambda/src/
├── handler.ts           # Main entry point
├── storage/
│   ├── s3.ts           # Raw event storage
│   └── dynamo.ts       # Event indexing
├── utils/
│   └── parse.ts        # Event parsing + future normalization
└── types/
    └── index.ts        # Type definitions
```

**Current behavior (Phase 1):**
- Authentication via webhook secret
- Raw event immutable storage in S3
- Fast indexed retrieval via DynamoDB
- No normalization or validation

**Phase 2 preparation:**
- Scaffolded normalization functions in `utils/parse.ts`
- Type definitions for canonical event envelope
- Test scaffolding for enrichment logic

See `lambda/README.md` for development guide.

⸻

Production Traffic Pattern

**Burst traffic:** ~500 devices at top of each hour
**Reporting window:** 6:00am–10:00pm Eastern Time
**Normal frequency:** Once per hour per device

**Deployment timing:**
- Preferred: bottom of the hour (e.g., 7:30, 8:30, 9:30 ET)
- Reason: minimize risk during top-of-hour reporting bursts

**Validation requirements:**
1. Immediate post-deploy validation
2. Monitor next top-of-hour reporting cycle
3. Verify burst handling maintained
