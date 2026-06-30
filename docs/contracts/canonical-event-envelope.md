Canonical Event Envelope

Purpose:

Defines the normalized telemetry contract for all events in the Unified Telemetry Project.

This schema is the internal observability contract.

Raw inbound payloads must remain immutable in S3.

Normalized and enriched events are indexed in DynamoDB using this contract.

⸻

Versioning Model

schemaVersion

Version of this envelope contract.

Rules:

* Increment minor for additive fields.
* Increment major for breaking changes.

Examples:

* 1.0
* 1.1
* 2.0

⸻

eventType

Stable semantic event classification.

Examples:

* telemetry.sensor
* telemetry.status
* forensic.watchdog
* forensic.reset
* serial.log
* serial.lifecycle
* alert.device

This should remain stable across raw webhook naming changes.

⸻

eventVersion

Version of the event payload contract.

This allows payload evolution without changing the envelope.

Examples:

* 1.0
* 2.0

⸻

Canonical Envelope

{
  "schemaVersion": "1.0",
  "eventId": "uuid",
  "projectId": "string",
  "deviceId": "string",
  "deviceName": "string|null",
  "eventTime": "ISO8601",
  "ingestTime": "ISO8601",
  "isSyntheticTime": false,
  "plane": "telemetry|forensic|serial",
  "eventType": "string",
  "eventVersion": "string",
  "eventName": "string",
  "sourceType": "string",
  "collectorId": "string|null",
  "severity": "INFO|WARN|ERROR|TRACE|null",
  "battery": "number|null",
  "connectTime": "number|null",
  "resetCount": "number|null",
  "alertCount": "number|null",
  "occupancy": "number|null",
  "dailyOccupancy": "number|null",
  "temperature": "number|null",
  "fwVersion": "string|null",
  "resetCause": "string|null",
  "networkState": "string|null",
  "queueDepth": "number|null",
  "payload": {},
  "rawRef": {
    "s3Key": "string"
  }
}

⸻

Storage Rules

S3:

Stores immutable raw request body.

DynamoDB:

Stores normalized and enriched canonical fields alongside the existing Phase 1
index fields. The `deviceId` partition key and `eventTime` sort key do not
change. Existing fields including `receivedAt`, `s3Key`, `fw_version`,
`public`, `dataType`, `transport`, and `logLine` remain available.

Large raw payloads should not be duplicated in DynamoDB.

Use rawRef.s3Key for replay.

Phase 2A does not copy `payload` into DynamoDB. The existing `s3Key` and the
canonical `rawRef.s3Key` both point to the unchanged raw S3 object.

If an inbound serial event supplies its own `eventType`, the normalized
classification is stored as `eventType` and the inbound value is retained as
`sourceEventType`.

⸻

Required Fields

Required:

* schemaVersion
* eventId
* projectId
* deviceId
* eventTime
* ingestTime
* plane
* eventType
* eventVersion
* eventName
* payload

Optional:

* deviceName
* collectorId
* severity
* battery
* connectTime
* resetCount
* alertCount
* occupancy
* dailyOccupancy
* temperature
* fwVersion
* resetCause
* networkState
* queueDepth

⸻

Event Evolution Rules

Raw event names may change.

eventType should remain stable whenever semantics remain equivalent.

Example:

Raw:

* watchdog
* watchdog-v2

Stable eventType:

* forensic.watchdog

Payload evolution should increment eventVersion.

⸻

Phase 2A Classification

Planes:

* `serial`: `sourceType == "serial-forwarder"` or `eventName == "serialLog"`
* `forensic`: event name contains watchdog, status, reset, boot, or fault
* `telemetry`: fallback

Stable event types:

* `serial.log`
* `serial.lifecycle`
* `fault.watchdog`
* `telemetry.status`
* `telemetry.occupancy`
* `telemetry.health`
* `telemetry.event`

Unknown event names are accepted and use `telemetry.event`. `isSyntheticTime`
is true when neither `published_at` nor `timestamp` was supplied and ingestion
time was used for `eventTime`.
