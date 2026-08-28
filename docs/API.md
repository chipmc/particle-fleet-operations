# Particle Log Monitoring - Query API

Read-only telemetry query API for device and fleet observability.

## Base URL

```
https://<api-gateway-id>.execute-api.us-east-1.amazonaws.com
```

Get the actual URL from CDK outputs:
```bash
cd infra
cdk deploy --outputs-file outputs.json
cat outputs.json | jq '.InfraStack.QueryApiBaseUrl'
```

## Authentication

**Current:**
All endpoints require the `x-particle-webhook-secret` header with the shared webhook secret.

```bash
export WEBHOOK_SECRET="<your-secret>"
```

**Future:**
Query endpoints will migrate to separate authentication:
- API keys for programmatic access
- OAuth/JWT for browser dashboard
- Read-only IAM role

Fleet endpoints currently reuse the shared secret only as an incremental rollout
measure. They should move to a separate read API secret or API key before broad
dashboard/client use.

## Endpoints

### 1. GET /device/{deviceId}/timeline

Returns chronological event list with normalized Phase 2A fields.

**Path Parameters:**
- `deviceId` (string, required): Device identifier

**Query Parameters:**
- `hours` (number, optional): Query last N hours. Default: 24, Max: 168
- `start` (ISO8601, optional): Explicit start time
- `end` (ISO8601, optional): Explicit end time
- `limit` (number, optional): Max events to return. Default: 100, Max: 1000

**Parameter Priority:**
If `start` and `end` are provided, `hours` is ignored.

**Example Request:**

```bash
curl -X GET "https://<api-url>/device/e00fce68e4fa8ab3f8faa207/timeline?hours=24&limit=100" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET"
```

**Example Response:**

```json
{
  "deviceId": "e00fce68e4fa8ab3f8faa207",
  "start": "2026-06-29T10:00:00.000Z",
  "end": "2026-06-30T10:00:00.000Z",
  "count": 24,
  "events": [
    {
      "eventTime": "2026-06-30T09:00:55.496Z",
      "eventName": "Ubidots-Sensor-Hook-v1",
      "eventType": "telemetry.occupancy",
      "plane": "telemetry",
      "battery": 88.5,
      "connectTime": 12,
      "resetCount": 3,
      "alertCount": 0,
      "temperature": 29.7,
      "occupancy": 5,
      "dailyOccupancy": 120,
      "severity": null,
      "s3Key": "particle-events/2026-06-30/Ubidots-Sensor-Hook-v1/e00fce68e4fa8ab3f8faa207/2026-06-30T09-00-55-496Z.json",
      "fwVersion": "14"
    }
  ]
}
```

**Response Fields:**

- `eventTime`: Event timestamp (from device or ingestion)
- `eventName`: Original event name from webhook
- `eventType`: Stable semantic classification (Phase 2A)
- `plane`: Event plane: telemetry, forensic, or serial

  > **Note:** The endpoint returns events across all planes in the queried time window.
  > There is no server-side filter for `plane`. Filtering by plane (e.g. serial-only output)
  > is performed client-side by `tools/telemetry serial` via `tools/event-presentation.js`,
  > not by any query parameter.
- `battery`: Battery percentage (if present)
- `connectTime`: Cellular connection time in seconds (if present)
- `resetCount`: Device reset counter (if present)
- `alertCount`: Active alerts (if present)
- `temperature`: Temperature reading (if present)
- `occupancy`: Occupancy count (if present)
- `dailyOccupancy`: Daily occupancy total (if present)
- `severity`: Log severity for serial events (TRACE|INFO|WARN|ERROR)
- `s3Key`: S3 key for raw immutable event
- `fwVersion`: Firmware version (if present)

---

### 2. GET /device/{deviceId}/health

Returns device health metrics and anomaly detection.

**Path Parameters:**
- `deviceId` (string, required): Device identifier

**Query Parameters:**
- `hours` (number, optional): Analysis window. Default: 24, Max: 168
- `start` (ISO8601, optional): Explicit start time
- `end` (ISO8601, optional): Explicit end time

**Example Request:**

```bash
curl -X GET "https://<api-url>/device/e00fce68e4fa8ab3f8faa207/health?hours=24" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET"
```

**Example Response:**

```json
{
  "deviceId": "e00fce68e4fa8ab3f8faa207",
  "timeSpan": {
    "start": "2026-06-29T10:00:00.000Z",
    "end": "2026-06-30T10:00:00.000Z",
    "hours": 24
  },
  "eventCount": 24,
  "battery": {
    "latest": 88.5,
    "min": 87.9,
    "max": 91.2,
    "average": 89.4,
    "change": -2.3
  },
  "connectTime": {
    "latest": 12,
    "min": 8,
    "max": 45,
    "average": 18
  },
  "resetCount": {
    "latest": 3,
    "change": 0
  },
  "alertCount": {
    "latest": 0,
    "max": 0
  },
  "temperature": {
    "latest": 29.7,
    "min": 28.1,
    "max": 31.2,
    "average": 29.8
  },
  "occupancy": {
    "latest": 5,
    "total": 120
  },
  "firmwareVersions": ["14"],
  "anomalies": []
}
```

**Metric Statistics:**

Each metric includes:
- `latest`: Most recent value
- `min`: Minimum value in window
- `max`: Maximum value in window
- `average`: Average value
- `change`: Difference between first and last value (if applicable)

**Anomaly Detection:**

Anomalies are detected based on these rules:
- **Battery**: < 30% (medium), < 20% (high)
- **Connection Time**: > 180s (medium), > 300s (high)
- **Reset Count**: Any increase (medium/high based on magnitude)
- **Alerts**: Any non-zero alerts (high)
- **Battery Drain**: > 30% drop in window (medium)
- **Firmware Changes**: Version changes (low)

---

### 3. GET /device/{deviceId}/summary

Returns high-level device statistics.

**Path Parameters:**
- `deviceId` (string, required): Device identifier

**Query Parameters:**
- `hours` (number, optional): Summary window. Default: 168 (7 days), Max: 720 (30 days)

**Example Request:**

```bash
curl -X GET "https://<api-url>/device/e00fce68e4fa8ab3f8faa207/summary?hours=168" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET"
```

**Example Response:**

```json
{
  "deviceId": "e00fce68e4fa8ab3f8faa207",
  "eventCount": 168,
  "firstEventTime": "2026-06-23T10:00:00.000Z",
  "lastEventTime": "2026-06-30T10:00:00.000Z",
  "timeSpan": {
    "hours": 168
  },
  "eventCounts": {
    "telemetry.occupancy": 160,
    "telemetry.health": 5,
    "fault.watchdog": 1,
    "serial.lifecycle": 2
  },
  "planes": {
    "telemetry": 165,
    "forensic": 1,
    "serial": 2
  },
  "firmwareVersions": ["14"],
  "recentAnomalyCount": 2
}
```

**Use Cases:**
- Quick device health check
- Identify event distribution patterns
- Track firmware versions
- Detect recent issues

---

### 4. GET /device/{deviceId}/anomalies

Returns detected anomalies and issues.

**Path Parameters:**
- `deviceId` (string, required): Device identifier

**Query Parameters:**
- `hours` (number, optional): Detection window. Default: 24, Max: 168
- `start` (ISO8601, optional): Explicit start time
- `end` (ISO8601, optional): Explicit end time
- `severity` (string, optional): Filter by minimum severity: `low`, `medium`, `high`

**Example Request:**

```bash
curl -X GET "https://<api-url>/device/e00fce68e4fa8ab3f8faa207/anomalies?hours=24&severity=medium" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET"
```

**Example Response:**

```json
{
  "deviceId": "e00fce68e4fa8ab3f8faa207",
  "count": 2,
  "anomalies": [
    {
      "severity": "medium",
      "type": "high_connect_time",
      "eventTime": "2026-06-30T08:15:00.000Z",
      "message": "High connection time: 185s (threshold: 180s)",
      "value": 185
    },
    {
      "severity": "low",
      "type": "firmware_change",
      "eventTime": "2026-06-29T14:30:00.000Z",
      "message": "Firmware changed from 13 to 14",
      "value": "13 → 14"
    }
  ]
}
```

**Anomaly Types:**

- `critical_battery`: Battery < 20%
- `low_battery`: Battery < 30%
- `very_high_connect_time`: Connection time > 300s
- `high_connect_time`: Connection time > 180s
- `reset_count_increase`: Reset counter increased
- `active_alerts`: Alert count > 0
- `firmware_change`: Firmware version changed
- `rapid_battery_drain`: Battery dropped > 30% in window

---

### 5. GET /fleet/summary

Returns fleet-level counts from the compact `DeviceCurrentState` table. This
endpoint does not scan the event-history table and does not read S3.

**Query Parameters:**
- `projectId` (string, optional): Project identifier. Default: `generalized-core-counter`
- `hours` (number, optional): Recent serial-error window. Default: 24
- `limit` (number, optional): Max current-state items to query. Default: 100, Max: 1000
- `status` (string, optional): Filter by `healthy`, `warning`, `critical`, or `unknown`

**Example Request:**

```bash
curl -X GET "https://<api-url>/fleet/summary?projectId=generalized-core-counter&limit=500" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET"
```

**Example Response:**

```json
{
  "projectId": "generalized-core-counter",
  "deviceCount": 500,
  "healthy": 460,
  "warning": 30,
  "critical": 10,
  "unknown": 0,
  "lowBatteryCount": 4,
  "highConnectTimeCount": 7,
  "alertingDeviceCount": 2,
  "recentSerialErrorCount": 5,
  "devices": [
    {
      "deviceId": "e00fce6841443bcc0f3178e4",
      "deviceName": "gateway-raleigh-01"
    },
    {
      "deviceId": "e00fce6841443bcc0f3178e5",
      "deviceName": null
    }
  ],
  "generatedAt": "2026-07-01T00:00:00.000Z"
}
```

---

### 6. GET /fleet/anomalies

Returns devices with current warning/critical health or compact recent
anomalies from `DeviceCurrentState`.

**Query Parameters:**
- `projectId` (string, optional): Project identifier. Default: `generalized-core-counter`
- `hours` (number, optional): Include devices with last events in this window. Default: 24
- `limit` (number, optional): Max current-state items to query. Default: 100, Max: 1000
- `status` (string, optional): Filter by `healthy`, `warning`, `critical`, or `unknown`

**Example Response:**

```json
{
  "projectId": "generalized-core-counter",
  "count": 2,
  "devices": [
    {
      "deviceId": "e00fce6841443bcc0f3178e4",
      "deviceName": "gateway-raleigh-01",
      "healthStatus": "warning",
      "lastEventTime": "2026-07-01T00:00:00.000Z",
      "battery": 22,
      "connectTime": 190,
      "anomalies": [
        {
          "severity": "medium",
          "type": "high_connect_time",
          "message": "Connect time exceeded 180 seconds"
        }
      ]
    }
  ]
}
```

---

### 7. GET /fleet/offline

Returns devices whose latest current-state event is older than the offline
threshold. This endpoint only exposes candidates; it does not page or alert.

**Query Parameters:**
- `projectId` (string, optional): Project identifier. Default: `generalized-core-counter`
- `thresholdHours` (number, optional): Offline threshold. Default: 3
- `limit` (number, optional): Max current-state items to query. Default: 100, Max: 1000

**Example Response:**

```json
{
  "projectId": "generalized-core-counter",
  "thresholdHours": 3,
  "count": 2,
  "devices": [
    {
      "deviceId": "e00fce6841443bcc0f3178e4",
      "deviceName": "gateway-raleigh-01",
      "lastEventTime": "2026-07-01T00:00:00.000Z",
      "lastPlane": "telemetry",
      "lastEventType": "telemetry.occupancy",
      "offlineCandidate": true
    }
  ]
}
```

---

## Error Responses

All endpoints use consistent error format:

```json
{
  "error": "error_code",
  "message": "Human-readable description",
  "statusCode": 400
}
```

**Status Codes:**

- `200`: Success
- `400`: Invalid parameters
- `401`: Authentication failed
- `404`: Device not found or no data
- `405`: Method not allowed
- `500`: Internal error

**Common Errors:**

```json
{
  "error": "unauthorized",
  "message": "Query endpoints require authentication",
  "statusCode": 401
}
```

```json
{
  "error": "invalid_parameter",
  "message": "hours must be between 1 and 168",
  "statusCode": 400
}
```

```json
{
  "error": "not_found",
  "message": "No data found for device: e00fce68e4fa8ab3f8faa207",
  "statusCode": 404
}
```

---

## Rate Limits

**Current:** API Gateway default throttling (10,000 requests/second)

**Future:** Per-client rate limiting will be implemented with separate authentication.

**Best Practices:**
- Cache responses when appropriate
- Use `limit` parameter to reduce data transfer
- Avoid polling; prefer event-driven notifications (future)

---

## Examples

### Check Recent Device Activity

```bash
# Last 24 hours
curl -X GET "https://<api-url>/device/$DEVICE_ID/timeline?hours=24" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET" \
  | jq '.count'
```

### Monitor Device Health

```bash
# Get health metrics
curl -X GET "https://<api-url>/device/$DEVICE_ID/health?hours=24" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET" \
  | jq '{battery: .battery.latest, anomalies: .anomalies | length}'
```

### Investigate Specific Time Window

```bash
# Query specific time range
curl -X GET "https://<api-url>/device/$DEVICE_ID/timeline?start=2026-06-30T14:00:00Z&end=2026-06-30T15:00:00Z" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET" \
  | jq '.events[] | {eventTime, eventType, battery, connectTime}'
```

### Check for Critical Issues

```bash
# High severity anomalies only
curl -X GET "https://<api-url>/device/$DEVICE_ID/anomalies?hours=24&severity=high" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET" \
  | jq '.anomalies'
```

### Device Summary Dashboard

```bash
# Weekly summary
curl -X GET "https://<api-url>/device/$DEVICE_ID/summary?hours=168" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET" \
  | jq '{eventCount, firmwareVersions, anomalyCount: .recentAnomalyCount}'
```

---

## Performance Characteristics

**Timeline Query:**
- Latency: ~50-200ms for typical queries
- DynamoDB read capacity: 1 RCU per KB
- S3 reads: None (uses DynamoDB normalized fields)

**Health Query:**
- Latency: ~100-300ms for typical queries
- DynamoDB read capacity: Higher for longer windows
- S3 reads: None (uses DynamoDB normalized fields)

**Summary Query:**
- Latency: ~100-300ms for typical queries
- DynamoDB read capacity: Depends on event count
- Aggregation: In-memory after DynamoDB fetch

**Anomalies Query:**
- Latency: ~100-300ms for typical queries
- Detection: Real-time heuristics on DynamoDB data
- S3 reads: None (uses DynamoDB normalized fields)

**Fleet Queries:**
- Data source: `DeviceCurrentState`
- DynamoDB access: `Query` by `projectId`
- Event-history scans: None
- S3 reads: None
- Serial forwarder signals: current serial `ERROR`/`WARN`, watchdog, reconnect,
  and reset detections are included in fleet anomaly status

**Optimization Tips:**
- Use shorter time windows when possible
- Leverage `limit` parameter
- Cache responses for dashboards
- Prefer anomalies endpoint for alert monitoring

---

## CLI Usage — tools/telemetry

`tools/telemetry` is the primary CLI for querying device telemetry. It supports
`timeline` (single bounded fetch) and `serial` (cloud-forwarded serial reconstruction)
commands, both of which accept `--start`/`--until`/`--since` flags.

### Time-window flags

| Flag | Commands | Description |
|---|---|---|
| `--since <duration>` | `timeline`, `serial`, `watch` | Relative lookback window. Examples: `30s`, `5m`, `1h`. Mutually exclusive with `--start`. |
| `--start <ISO8601>` | `timeline`, `serial` | Absolute start timestamp. Mutually exclusive with `--since`. |
| `--until <ISO8601>` | `timeline`, `serial` | Absolute end timestamp. Defaults to now when `--start` is given. |
| `--hours <n>` | `timeline` | Relative lookback in hours (default: 24). Ignored when `--since` or `--start` is given. |

**Mutual-exclusion rule:** Passing both `--start` and `--since` exits with an error:

```
ERROR: --start and --since are mutually exclusive; use one or the other.
```

**Truncation signaling:** When a bounded `timeline` or non-`--follow` `serial`
result is partial, the CLI still writes the data to stdout, then exits with code
`3` and prints this warning to stderr:

```
WARN: results truncated at <N> events (--limit), narrow your window or raise --limit.
```

- `timeline --json` includes `truncated: true|false` and `limit`, and its
  `count`/`events` reflect the emitted (trimmed) result set.
- For `timeline`, and for bounded `serial` runs that fetch through the HTTP
  query API, results at or above the upstream 1000-event clamp may
  conservatively report `truncated: true` because the CLI cannot distinguish a
  complete 1000-event window from a clamped partial response on that path.
- `serial --json` remains NDJSON. For bounded, non-`--follow` runs it appends
  one trailing summary record after the data lines:

  ```json
  {"record":"summary","truncated":true,"count":25,"limit":25}
  ```

- `serial --follow` emits no summary record and does not use truncation exit
  code `3`.
- Complete bounded results keep `truncated: false` and exit `0`, including
  complete windows with exactly `--limit` events on the DynamoDB path and other
  non-clamped paths.
- Bounded `serial --limit 1` keeps oldest-first emission order; a one-row output
  remains complete only when the requested window contains exactly one matching
  serial row.

**`watch --start` is not supported.** The `watch` command tails near-live events and
uses a cursor-based poll loop; `--start` is rejected with a clear error:

```
ERROR: --start is not supported for watch; use --since.
```

### Examples

```bash
# timeline: last 2 hours (relative)
./tools/telemetry timeline Boron-Dev-09 --since 2h

# timeline: absolute window
./tools/telemetry timeline Boron-Dev-09 --start 2026-08-01T08:00:00Z --until 2026-08-01T10:00:00Z

# serial: absolute start, end defaults to now
./tools/telemetry serial Boron-Dev-09 --start 2026-08-01T08:00:00Z

# serial: relative window with follow
./tools/telemetry serial Boron-Dev-09 --since 1h --follow
```

---

## Migration Notes

### From CLI Timeline Tool

The CLI tool (`npm run timeline`) and API provide similar data:

**CLI:**
```bash
npm run timeline -- --deviceId $DEVICE_ID --hours 24
```

**API:**
```bash
curl "https://<api-url>/device/$DEVICE_ID/timeline?hours=24" \
  -H "x-particle-webhook-secret: $WEBHOOK_SECRET"
```

**Key Differences:**
- API returns JSON, CLI provides formatted output
- API has configurable limits, CLI shows all events
- API is suitable for programmatic access and dashboards
- CLI includes additional debug output

---

## Future Enhancements

- **Authentication**: Separate API keys and OAuth support
- **WebSockets**: Real-time event streaming
- **GraphQL**: Flexible query interface
- **Caching**: CloudFront for frequently accessed data
- **Fleet Queries**: Cross-device analytics
- **Notifications**: Webhook alerts for anomalies
- **Rate Limiting**: Per-client quotas
- **Pagination**: Cursor-based pagination for large result sets

---

## Support

For issues or questions:
1. Check CloudWatch Logs: `/aws/lambda/InfraStack-ParticleLogIngestionFunction...`
2. Verify authentication header
3. Validate query parameters
4. Check device ID exists in DynamoDB
5. Review Phase 2A normalization status
