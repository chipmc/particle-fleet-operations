# Tools Guide

Local inspection and diagnostic tools for particle-log-monitoring.

## Device Timeline Inspector

### Purpose

Query and inspect device event timelines using data already collected in DynamoDB and S3.

**Capabilities:**
- Read-only queries (no AWS resource modification)
- Chronological event display
- Time-range filtering
- Raw event inspection from S3
- Works with current Phase 1 schema

**Does NOT:**
- Modify DynamoDB or S3
- Change Lambda behavior
- Perform normalization (Phase 2)
- Write to AWS resources
- Require infrastructure deployment

### Quick Start

```bash
cd scripts
npm install
npm run build
npm run timeline -- --deviceId <deviceId> --hours 24
```

### Common Use Cases

#### 1. Check Recent Device Activity

```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24
```

**When to use:**
- Verify device is reporting
- Check for missing events
- Quick health check

#### 2. Investigate Specific Time Window

```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --start 2026-06-26T14:00:00Z \
  --end 2026-06-26T15:00:00Z
```

**When to use:**
- Troubleshoot reported incident
- Verify deployment impact
- Compare before/after windows

#### 3. Analyze Watchdog/Reset Events

```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --hours 168 \
  --show-raw
```

**When to use:**
- Forensic analysis
- Pattern detection
- Root cause investigation

#### 4. Validate Post-Deployment

```bash
# Check synthetic test event
npm run timeline -- --deviceId test-device --hours 1 --show-raw

# Verify production device behavior
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 2
```

**When to use:**
- After Lambda deployment
- After infrastructure changes
- Smoke testing

### Output Interpretation

#### Timeline Display

```
╔════════════════════════════════════════════════════════════╗
║  Device Timeline                                           ║
╚════════════════════════════════════════════════════════════╝

Device ID:   e00fce68e4fa8ab3f8faa207
Start Time:  2026-06-26T12:00:00.000Z
End Time:    2026-06-27T12:00:00.000Z
Event Count: 24

[1] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Event:      Ubidots-Sensor-Hook-v1
Time:       2026-06-26T13:00:00.000Z
Received:   2026-06-26T13:00:05.123Z
Data Type:  object
Firmware:   2.4.0
S3 Key:     particle-events/2026-06-26/Ubidots-Sensor-Hook-v1/...
```

**Key fields:**
- **Event**: Event name (from Particle webhook or serial forwarder)
- **Time**: Event timestamp from device (published_at)
- **Received**: Ingestion timestamp (when Lambda processed)
- **Data Type**: Type of parsed data (object, string, number)
- **Firmware**: Device firmware version (if available)
- **S3 Key**: Location of raw immutable event

#### Extended Fields

For serial forwarder events, you may see:

```
Source:     serial-forwarder
Collector:  pi-shed-01
Type:       serial.log
Log:        [2026-06-26 13:00:00] Device connected, modem ready
```

**Additional fields:**
- **Source**: Event source type (particle-webhook vs serial-forwarder)
- **Collector**: Raspberry Pi collector ID
- **Type**: Semantic event classification
- **Log**: Serial log line preview (first 80 chars)

#### Raw Event Data

With `--show-raw`, shows complete S3 payload:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Raw Event Data (from S3)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Particle Webhook:
{
  "event": "Ubidots-Sensor-Hook-v1",
  "coreid": "e00fce68e4fa8ab3f8faa207",
  "published_at": "2026-06-26T13:00:00.000Z",
  "data": "{\"temperature\":72.5,\"battery\":95}",
  "fw_version": "2.4.0",
  "public": false
}

Parsed Data:
{
  "eventName": "Ubidots-Sensor-Hook-v1",
  "deviceId": "e00fce68e4fa8ab3f8faa207",
  "publishedAt": "2026-06-26T13:00:00.000Z",
  "receivedAt": "2026-06-26T13:00:05.123Z",
  "data": {
    "temperature": 72.5,
    "battery": 95
  }
}
```

### Troubleshooting

#### Error: Could not determine AWS resource names

**Cause:** Script cannot auto-detect DynamoDB table or S3 bucket.

**Solution 1:** Specify explicitly:
```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --table InfraStack-ParticleLogEventsTable123ABC \
  --bucket infrastack-rawparticlelogsbucket456DEF
```

**Solution 2:** Set environment variables:
```bash
export LOG_EVENTS_TABLE_NAME=InfraStack-ParticleLogEventsTable123ABC
export RAW_LOGS_BUCKET_NAME=infrastack-rawparticlelogsbucket456DEF
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207
```

**Solution 3:** Verify CloudFormation stack exists:
```bash
AWS_PROFILE=particle-admin aws cloudformation describe-stacks --stack-name InfraStack
```

#### Error: No events found

**Possible causes:**
1. Incorrect deviceId (check case and format)
2. Time range too narrow
3. Device hasn't reported yet
4. Events outside specified window

**Debugging:**
```bash
# Check recent events (wider window)
npm run timeline -- --deviceId <deviceId> --hours 168

# Check if device exists in DynamoDB
AWS_PROFILE=particle-admin aws dynamodb query \
  --table-name <TABLE_NAME> \
  --key-condition-expression "deviceId = :d" \
  --expression-attribute-values '{":d":{"S":"<deviceId>"}}' \
  --limit 1
```

#### Error: Access Denied

**Cause:** AWS profile lacks permissions.

**Solution:** Verify IAM permissions:
```bash
# Test DynamoDB access
AWS_PROFILE=particle-admin aws dynamodb describe-table \
  --table-name <TABLE_NAME>

# Test S3 access
AWS_PROFILE=particle-admin aws s3 ls s3://<BUCKET_NAME>/
```

Required permissions:
- `dynamodb:Query` on events table
- `s3:GetObject` on raw logs bucket

### Integration with Operations

This tool complements operational procedures documented in [operations.md](./operations.md):

**Pre-deployment:**
- Verify baseline device behavior
- Capture normal event patterns

**Post-deployment:**
- Validate synthetic test events
- Compare production device timelines
- Verify no missing events during burst

**Incident response:**
- Query device timeline during incident window
- Fetch raw events for forensic analysis
- Compare affected vs healthy devices

### Performance Notes

- Queries are indexed by `deviceId` (fast)
- Time-range filtering uses sort key (efficient)
- Limit parameter prevents excessive data transfer
- Raw S3 fetches incur additional latency
- Use specific time windows for better performance

### Future Enhancements (Phase 2+)

When canonical schema normalization is implemented:

- Display normalized `eventType` (stable classification)
- Show enriched fields (`plane`, `severity`, etc.)
- Filter by event plane (telemetry/forensic/serial)
- Search by semantic event type
- Timeline merge across multiple devices

Current tool will continue to work with Phase 1 schema during migration.

---

See [scripts/README.md](../scripts/README.md) for detailed CLI reference.
