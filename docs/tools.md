# Tools Guide

Local inspection and diagnostic tools for particle-log-monitoring.

## Telemetry Operator CLI

### Purpose

Use the deployed telemetry stack without memorizing DynamoDB table names, API Gateway URLs, or Particle device IDs.

### Prerequisites

- Node.js 18 or newer
- AWS CLI authenticated for the account and region containing `InfraStack`
- Deployed `InfraStack` with `DeviceCurrentStateTableName` and `QueryApiBaseUrl` outputs

If your AWS CLI profile does not have a default region, pass `--region <region>` or set `AWS_REGION`/`AWS_DEFAULT_REGION`.

### Quick Start

```bash
cd ~/Documents/Maker/AWS/particle-log-monitoring

./tools/telemetry devices
./tools/telemetry device e00fce68399ee6244a963935
./tools/telemetry timeline e00fce68399ee6244a963935 --hours 24
```

### Commands

```bash
./tools/telemetry devices
./tools/telemetry device <name-or-device-id>
./tools/telemetry timeline <name-or-device-id> --hours 24 --limit 50
```

All commands support `--json`. Device selectors accept a full Particle device ID, exact device name, or unambiguous partial device name. The tool discovers deployed resources from CloudFormation and uses the existing query API for timeline reads.

## Device Timeline Inspector

### Purpose

Query and inspect device event timelines using data already collected in DynamoDB and S3.

**Capabilities:**
- Read-only queries (no AWS resource modification)
- Chronological event display
- Time-range filtering
- Raw event inspection from S3
- **Analytics summary mode** (event patterns, gaps, bursts, anomalies)
- **Health diagnostics mode** (payload-aware device health analysis)
- Works with Phase 1 and additive Phase 2A records

**Does NOT:**
- Modify DynamoDB or S3
- Change Lambda behavior
- Modify or replay normalized records
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
 with summary
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 2 --summary
```

**When to use:**
- After Lambda deployment
- After infrastructure changes
- Smoke testing

#### 5. Get Analytics Summary

```bash
npm rAnalytics Summary (with --summary flag)

```
================================================================
  Device Timeline
==================================================================

Device ID:     e00fce6841443bcc0f3178e4
Total Events:  36
First Event:   2026-06-27T10:00:55.496Z
Last Event:    2026-06-28T02:00:11.974Z
Time Span:     16 hours

--- INGEST PERFORMANCE ---
Average Delay: 365ms
Min Delay:     97ms
Max Delay:     755ms

--- EVENT COUNTS ---
Ubidots-Sensor-Hook-v1         36

--- FIRMWARE VERSIONS ---
  14

--- TIME GAPS ---
No significant gaps detected

--- EVENT BURSTS (3+ events within 10 min) ---
  3 events from 2026-06-27T13:15:20.695Z to 2026-06-27T13:23:13.251Z
    Events: Ubidots-Sensor-Hook-v1(3)

--- ANOMALIES ---
No anomalies detected

================================================================
```

**Key metrics explained:**

- **Total Events**: Number of events in query window
- **Time Span**: Duration from first to last event
- **Ingest Performance**: Latency between device event time and ingestion (receivedAt - eventTime)
  - Average is typical latency
  - High max values may indicate network issues
- **Event Counts**: Breakdown by event name, sorted by frequency
- **Firmware Versions**: All firmware versions seen
- **Time Gaps**: Periods with no events exceeding threshold
  - Useful for detecting device offline periods
  - Default threshold: 90 minutes
- **Event Bursts**: Clusters of 3+ events within 10 minutes
  - May indicate device reconnection/retry behavior
  - May indicate unusual activity
- **Anomalies**: Detected issues
  - Missing eventTime
  - High ingest delay (> 5 seconds and > 2x average)
  - Repeated burst patterns

#### un timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24 --summary
```

**When to use:**
- Quick health check with metrics
- Identify patterns and anomalies
- Detect reporting gaps or bursts
- Performance analysis
- Pre/post-deployment comparison

**Summary includes:**
- Event count by event name
- First/last event time and time span
- Ingest performance (average/min/max delay)
- Time gaps larger than threshold (default 90 min)
- Event bursts (3+ events within 10 minutes)
- Firmware versions seen
- Serial lifecycle event counts (if present)
- Detected anomalies

**Custom gap threshold:**
```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --hours 24 \
  --summary \
  --gap-threshold 30
```

#### 6. Get Device Health Diagnostics

```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24 --health
```

**When to use:**
- Device health assessment
- Battery monitoring
- Connection quality check
- Reset count tracking
- Temperature monitoring
- Alert detection
- Firmware version validation

**Health diagnostics includes:**
- Battery: latest, min, max, average, change over window
- Connection time: latest, min, max, average (detects high connection times)
- Reset count: latest, change (detects increasing resets)
- Alert count: latest, non-zero detection
- Temperature: latest, min, max, average, change
- Occupancy metrics: current and daily counts
- Firmware versions and changes during window
- Anomaly detection:
  - Battery < 30% (medium severity)
  - Battery < 20% (high severity)
  - Connection time > 180s (medium/high severity)
  - Reset count increasing (medium/high severity)
  - Active alerts detected (high severity)
  - Firmware version changes (low severity)
  - Rapid battery drain > 30% (medium severity)

**Note:** Health mode fetches all S3 payloads to parse device telemetry data. This is more intensive than summary mode but provides detailed device health insights.

#### 7. Event Correlation Analysis

```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24 --correlate
```

**When to use:**
- Identify root causes of device issues
- Investigate connectivity problems
- Analyze reboot patterns
- Detect causal relationships between events
- Debug intermittent failures
- Pattern detection across event types

**Correlation analysis includes:**
- Groups events into configurable time windows (default 5 minutes)
- Correlates telemetry, watchdog, status, serial lifecycle, and serial logs
- Extracts and displays:
  - Telemetry: battery, connection time, temperature, resets, alerts, occupancy
  - Watchdog events with reset causes
  - Status data: cloud recovery stage, network state, queue depth
  - Serial lifecycle: connect/disconnect/missing events
  - Serial logs: categorized by modem, network, power, error, reconnect
- Applies 8 heuristic inference rules:
  1. Connectivity degradation (high connection time + modem errors)
  2. USB instability (repeated serial connect/disconnect)
  3. Network stall causing watchdog
  4. Device reboot (reset count increase + watchdog)
  5. Power anomaly (low battery + alerts)
  6. Reconnect loop (multiple reconnect attempts)
  7. High connection time (> 180s)
  8. Critical battery (< 20%)
- Shows summary with total inferences, severity counts, top categories
- Each inference includes severity (CRITICAL/WARNING/INFO), category, message, evidence

**Custom window size:**
```bash
# Use 10-minute windows for broader pattern detection
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 48 --correlate --window 10
```

**Note:** Correlation mode fetches all S3 payloads to analyze event relationships. It is the most comprehensive diagnostic mode, providing causal analysis beyond simple metrics.

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

Phase 2A timeline records may also include `plane`, stable `eventType`,
`severity`, normalized health metrics, and `rawRef.s3Key`. Older Phase 1
records remain valid. Serial lifecycle analysis reads `sourceEventType` when
present and falls back to the legacy `eventType` layout.

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

#### Health Diagnostics (with --health flag)

Parses Particle webhook payloads to extract device health metrics:

```
================================================================
  DEVICE HEALTH SUMMARY
================================================================

Device ID:     e00fce6841443bcc0f3178e4
Total Events:  20
First Event:   2026-06-27T10:00:55.496Z
Last Event:    2026-06-27T14:11:20.932Z
Time Span:     4.2 hours

--- HEALTH METRICS ---

Battery:
  Latest:  91.80 %
  Min:     91.49 %
  Max:     91.80 %
  Average: 91.62 %
  Change:  +0.15 % (over 20 readings)

Connection Time:
  Latest:  1.00 s
  Min:     1.00 s
  Max:     33.00 s
  Average: 3.15 s
  Change:  0.00 s (over 20 readings)

Temperature:
  Latest:  38.08 °C
  Min:     25.11 °C
  Max:     38.08 °C
  Average: 30.98 °C
  Change:  +10.48 °C (over 20 readings)

--- FIRMWARE VERSIONS ---
  14

--- ANOMALIES DETECTED ---

MEDIUM SEVERITY:
  [TEMPERATURE] Temperature increased significantly: +10.48°C

================================================================
```

**Key health metrics explained:**

- **Battery**: Percentage charge level
  - Monitor for low battery (< 30%)
  - Watch for rapid drain (> 30% drop)
  - Change shows trend over time window
- **Connection Time**: Seconds to establish cellular connection
  - Normal: 1-30s
  - Warning: > 60s
  - Critical: > 180s
  - High values indicate network issues
- **Reset Count**: Cumulative device reset counter
  - Should remain stable
  - Increases indicate crashes or watchdog resets
  - Track changes to identify instability
- **Alert Count**: Active device alerts
  - Should be 0 under normal operation
  - Non-zero indicates device-reported issues
- **Temperature**: Device temperature in °C
  - Monitor for extreme values
  - Sudden changes may indicate environmental issues
- **Occupancy**: Current occupancy count (for counter devices)
- **Daily Occupancy**: Daily cumulative count

**Anomaly severity levels:**
- **HIGH**: Immediate attention needed (low battery < 20%, active alerts, high resets)
- **MEDIUM**: Monitor closely (battery < 30%, connection issues, reset increases)
- **LOW**: Informational (firmware changes, minor variations)

**Payload field mapping:**
- Extracts from Particle webhook `data` JSON string
- Supports HTML-encoded JSON (from Particle webhooks)
- Falls back to top-level particle fields
- Handles both `temp` and `temperature` field names

#### Event Correlation (with --correlate flag)

Groups events into time windows and applies inference rules to detect patterns:

```
================================================================
  EVENT CORRELATION ANALYSIS
================================================================

Device ID:       e00fce6841443bcc0f3178e4
Time Range:      2026-06-27T10:00:55.496Z to 2026-06-27T14:11:20.932Z
Window Duration: 5 minutes
Window Count:    17

--- SUMMARY ---
Total Inferences: 3
  Critical:       1
  Warning:        2
  Info:           0

Top Categories:
  connectivity: 2
  power: 1

================================================================

Window 8
----------------------------------------------------------------
Time Range: 2026-06-27T12:15:00.000Z to 2026-06-27T12:20:00.000Z
Duration:   5 minutes
Events:     4

TELEMETRY:
  - Ubidots-Sensor-Hook-v1: battery=25.3%, connecttime=195s, temp=28.1°C, resets=5, alerts=2, occupancy=1

WATCHDOG:
  - watchdog: network timeout

STATUS:
  - status: cloudRecoverStage=2, networkState=disconnected

SERIAL LOGS:
  - [modem] MODEM ERROR: cellular connection failed
  - [network] Network registration timeout

INFERENCES:
  🔴 CRITICAL | connectivity | Network stall causing watchdog
    Evidence: Watchdog reset with high connection time (195s) and network errors
  
  🔴 CRITICAL | power | Power anomaly detected
    Evidence: Low battery (25.3%) with 2 active alerts
  
  ⚠️  WARNING | connectivity | Connectivity degradation
    Evidence: High connection time (195s) with modem errors in window

================================================================
```

**Key correlation features:**

- **Time Windows**: Events grouped by proximity (default 5 minutes, configurable)
- **Multi-Event Correlation**: Analyzes relationships between:
  - Telemetry (battery, connection time, resets, alerts, temperature)
  - Watchdog events (reset causes)
  - Status events (cloud recovery, network state)
  - Serial lifecycle (USB connect/disconnect)
  - Serial logs (modem, network, power errors)
- **Inference Rules**: 8 heuristic patterns detect:
  - Connectivity issues (high connect time, modem errors, reconnect loops)
  - Hardware problems (USB instability, watchdog resets)
  - Power anomalies (low battery with alerts)
  - Device reboots (reset count increases)
- **Evidence-Based**: Each inference shows supporting data
- **Severity Levels**:
  - 🔴 **CRITICAL**: Immediate action needed (watchdog, low battery + alerts)
  - ⚠️  **WARNING**: Monitor closely (high connect time, USB flapping, reconnect loops)
  - ℹ️  **INFO**: Informational (minor anomalies)

**Inference categories:**
- **connectivity**: Network and cellular issues
- **power**: Battery and power-related problems
- **stability**: Crashes, resets, watchdog events
- **hardware**: USB, serial, and physical device issues

**Window duration:**
- Smaller windows (2-5 min): Detect rapid event sequences
- Larger windows (10-30 min): Identify broader patterns
- Adjust with `--window <minutes>` based on investigation needs

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
