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

Stores normalized and enriched canonical envelope.

Large raw payloads should not be duplicated in DynamoDB.

Use rawRef.s3Key for replay.

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