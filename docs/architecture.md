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

Phase 2A writes normalized/enriched attributes onto the same item. It does not
change the table keys, API Gateway, or S3 path/body format. Legacy Phase 1
attributes remain in place, while canonical fields provide stable plane and
event-type classification plus common telemetry metrics.

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
│   └── parse.ts        # Event parsing + Phase 2A normalization
└── types/
    └── index.ts        # Type definitions
```

**Current behavior (Phase 2A):**
- Authentication via webhook secret
- Raw event immutable storage in S3
- Fast indexed retrieval via DynamoDB
- Additive canonical normalization in `utils/parse.ts`
- Stable telemetry, forensic, and serial classification
- Common health/occupancy metric extraction
- Best-effort enrichment; normalization failure does not block ingestion
- Unknown event types remain accepted

The DynamoDB `deviceId`/`eventTime` key model is unchanged. Raw serial
`eventType` values are retained as `sourceEventType` when the canonical
`eventType` is written.

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
