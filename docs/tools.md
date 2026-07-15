# Tools Guide

Local inspection and diagnostic tools for particle-log-monitoring.

## Telemetry Operator CLI

### Purpose

Use the deployed telemetry stack without memorizing DynamoDB table names, API Gateway URLs, or Particle device IDs.

### Prerequisites

- Node.js 18 or newer
- AWS CLI authenticated for the account and region containing `InfraStack`
- Deployed `InfraStack` with `DeviceCurrentStateTableName` and `QueryApiBaseUrl` outputs
- `PARTICLE_ACCESS_TOKEN` in the local shell or `~/.particle-log-monitoring/secrets.env` for Particle inventory lookups

If your AWS CLI profile does not have a default region, pass `--region <region>` or set `AWS_REGION`/`AWS_DEFAULT_REGION`.

Particle credentials are local operator credentials. The CLI prefers `PARTICLE_ACCESS_TOKEN` from the current shell and then reads `~/.particle-log-monitoring/secrets.env` if present. It does not use the deployed Lambda environment as the normal Particle credential source and never prints token values.

### Quick Start

```bash
cd ~/Documents/Maker/AWS/particle-log-monitoring

./tools/telemetry devices
./tools/telemetry fleet
./tools/telemetry device e00fce68399ee6244a963935
./tools/telemetry timeline e00fce68399ee6244a963935 --hours 24
./tools/telemetry serial Boron-Dev-09 --since 1h
./tools/telemetry watch P2-NewCode-Dev
```

### Installation

Install the operator CLI once from the repository root:

```bash
cd ~/Documents/Maker/AWS/particle-log-monitoring
./tools/install
```

The installer creates or updates these symlinks:

```text
/usr/local/bin/telemetry -> <repo>/tools/telemetry
/usr/local/bin/fleetops  -> <repo>/tools/telemetry
```

After installation, operators can run the CLI from any directory:

```bash
telemetry --help
telemetry fleet
telemetry watch Boron-Dev-09
telemetry serial Boron-Dev-09 --since 1h
telemetry timeline Boron-Dev-09
fleetops fleet
```

If `/usr/local/bin` is not writable, rerun the installer with `sudo ./tools/install`. The installer does not attempt privilege escalation automatically and refuses to overwrite an existing non-symlink command. To remove the installed commands, run `./tools/uninstall` from any directory with write access to `/usr/local/bin`; use `sudo ./tools/uninstall` when needed.

### Commands

```bash
./tools/telemetry --help
./tools/telemetry help [command]
./tools/telemetry devices
./tools/telemetry fleet --product-id 42131
./tools/telemetry device <name-or-device-id>
./tools/telemetry timeline <name-or-device-id> --hours 24 --limit 50
./tools/telemetry timeline <name-or-device-id> --since 1h --limit 50
./tools/telemetry serial <name-or-device-id> --since 1h
./tools/telemetry watch <device-selector>
```

Use `./tools/telemetry <command> --help` or `./tools/telemetry help <command>` for command-specific help. Help commands run locally and do not require AWS authentication or network access.

All data commands support `--json`. Device selectors accept a full Particle device ID, exact device name, or unambiguous partial device name. The tool discovers deployed resources from CloudFormation and uses the existing query API for timeline reads.

### Fleet Summary

```bash
./tools/telemetry fleet
./tools/telemetry fleet --product-id 42131
./tools/telemetry fleet --activity-limit 5
./tools/telemetry fleet --json
./tools/telemetry fleet --verbose
```

`fleet` is the first Fleet Operations summary command. It scopes the report to one Particle product, defaulting to Product `42131`, and joins Particle product inventory, `DeviceCurrentState`, and the existing runtime projection. It does not infer health.

`fleet` requires a local Particle operator token because Product inventory comes from the Particle API. Source the local operator cache before running if the token is not already in your shell:

```bash
source "${HOME}/.particle-log-monitoring/secrets.env"
echo "PARTICLE_ACCESS_TOKEN=${PARTICLE_ACCESS_TOKEN:+SET}"
```

The confirmation command reports only whether a token is set; it does not expose the token.

The text report includes:
- Fleet header
- Compact overview with Coverage, Cloud, Firmware, Device OS, and Battery SOC shown side by side in normal-width terminals
- Devices Requiring Attention section with factual per-device observations
- Device table with compact evidence columns: `CS` for current state, `RT` for runtime status, and `DD` for device data
- Recent Activity section derived from existing fleet summary/current-state evidence

Compact overview example:

```text
Fleet Summary: Product 42131
Schema: fleet-summary.v1
Generated: 2026-07-14T12:01:38.528Z

COVERAGE                  CLOUD             FIRMWARE          DEVICE OS     BATTERY SOC
Inventory       6 / 6     Online       5    20          5     6.4.1   6     Observed  4 / 6
Current State   5 / 6     Offline      1    <unknown>   1                  Lowest    18%
Runtime Status  4 / 6     Unknown      0                                  Median    54%
Device Data     Not Enabled                                                Unknown   2
```

For narrow terminals, the overview falls back to stacked sections so values remain readable and are not silently truncated.

Default text output uses relative times such as `2 min ago` and labels the activity column `Last Heard`. Use `--verbose` to show ISO timestamps and additional per-device metadata.

When no devices have produced Device Data, the text coverage line reports `Device Data: Not Enabled` and Device Data is not listed as an operator attention item. If any device begins publishing Device Data later, the report automatically returns to numeric Device Data coverage and can show per-device Device Data observations.

Runtime table values are evidence labels only: `Observed`, `Pending`, or `Unknown`. Fleet Summary does not infer health.

Terminology:
- `CS`: Current State. Indicates that a `DeviceCurrentState` projection exists for the device.
- `RT`: Runtime Status. Indicates that a `device-status` Ledger snapshot has been projected.
- `DD`: Device Data. Indicates that a `device-data` Ledger snapshot has been projected.
- `Cloud`: Point-in-time Particle Cloud connection status. `Online` or `Offline` is not equivalent to device health because sleeping devices may normally be offline.
- `Last Heard`: The most recent time Particle Cloud heard from the device.
- `Firmware`: The application firmware version reported by Particle.
- `Device OS`: The Particle Device OS version reported by Particle.
- `SOC`: Battery State of Charge. Fleet Summary prefers the `device-status` Ledger SOC value and falls back to telemetry-derived battery SOC when needed.
- `Runtime`: Human-readable presence state for the runtime-status projection: `Observed`, `Pending`, or `Unknown`.
- `Coverage`: Evidence completeness across the Particle product inventory.
- `Attention`: Factual observations that may warrant operator review. This is not a derived health classification.
- `Recent Activity`: Recent fleet observations, newest first.

Product inventory is authoritative for fleet membership. `CS`, `RT`, and `DD` are evidence-presence indicators, not health scores. `Device Data: Not Enabled` means no device in the scoped product currently has a `device-data` projection.

Devices Requiring Attention groups factual observations by device. For an online device that has not reported telemetry yet, the section says `Cloud connected` and `Waiting for first telemetry` instead of listing low-level missing projections. For devices with existing telemetry but missing runtime projection evidence, observations use factual wording such as `Last heard 6 hours ago` and `Runtime status not yet observed`. Stale SOC evidence is reported factually, for example `Last reported SOC 18%` and `SOC observation is 7 hr old`; Fleet Summary does not label SOC as healthy, low, warning, or critical. An empty section means no observations apply in the current snapshot.

Recent Activity is newest-first and intentionally lightweight. It uses the shared event presentation layer to classify projected latest-event metadata as `SERIAL`, `COLLECTOR`, `TELEMETRY`, `LIFECYCLE`, or a neutral `EVENT`. Online inventory-only devices with Particle last-heard time appear as an `EVENT` with summary `Connected to Particle Cloud`. Use `--activity-limit <n>` to control the row count. No additional backend APIs are used.

Interactive terminal output may use ANSI color for compact status cues. Color is automatically disabled for redirected output, `--json`, or when `NO_COLOR` is set.

Options:
- `--product-id <id>`: Particle product ID. Default is `42131`.
- `--activity-limit <n>`: Recent Activity row limit. Default is `10`; use `0` to hide activity rows.
- `--json`: Emit stable `fleet-summary.v1` JSON.
- `--verbose`: Include additional per-device metadata, such as exact SOC observation timestamp/source, Particle last-heard time, Ledger update time, and last event type.

`fleet --json` uses the same internal Fleet Summary object as the text renderer. `fleet --verbose --json` includes the additional per-device metadata in the JSON device records.

Coverage in `fleet-summary.v1` JSON is reported with stable keys:

```json
{
  "coverage": {
    "inventory": 12,
    "currentState": 11,
    "runtimeStatus": 10,
    "deviceData": 9
  }
}
```

Battery SOC in `fleet-summary.v1` JSON is additive. Missing SOC remains `null` per device and contributes to the fleet unknown count:

```json
{
  "batterySoc": {
    "observed": 4,
    "inventory": 6,
    "unknown": 2,
    "lowest": 18,
    "median": 54
  },
  "devices": [
    {
      "deviceId": "e00fce68399ee6244a963935",
      "deviceName": "SAMIT-TRAIL02",
      "socPercent": 18,
      "socObservedAt": "2026-07-14T05:00:00.000Z",
      "socSource": "device-status"
    }
  ]
}
```

JSON may also include an optional `attention` array with structured operator observations:

```json
{
  "attention": [
    {
      "deviceId": "e00fce68399ee6244a963935",
      "deviceName": "SAMIT-TRAIL02",
      "observations": [
        "Last heard 6 hours ago",
        "Runtime status not yet observed"
      ]
    }
  ]
}
```

JSON may also include additive `recentActivity` rows:

```json
{
  "recentActivity": [
    {
      "time": "2026-07-14T11:58:00.000Z",
      "deviceId": "e00fce68399ee6244a963935",
      "deviceName": "Morrisville-Tennis-MAFC-1",
      "kind": "TELEMETRY",
      "summary": "Occupancy report",
      "severity": null,
      "eventType": "telemetry.occupancy",
      "sourcePlane": "telemetry"
    }
  ]
}
```

### Shared Event Presentation

`timeline`, `watch`, `serial`, and Fleet Summary Recent Activity translate canonical events through one operator-facing presentation record. Canonical fields remain unchanged in command JSON; presentation adds a concise `kind`, evidence-only `summary`, normalized `severity`, and source identity when the read model supplies it.

Kinds:
- `SERIAL`: Firmware-generated serial output (`eventType=serial.log`).
- `COLLECTOR`: Serial Forwarder transport and USB lifecycle observations.
- `LIFECYCLE`: Particle application event named `status`.
- `RUNTIME`: `device-status` Ledger snapshot activity.
- `DATA`: `device-data` Ledger snapshot activity.
- `TELEMETRY`: Application measurements and normal published events.
- `WATCHDOG`: Explicit watchdog or fault evidence.
- `ERROR`: Other canonical events with error or critical severity.
- `EVENT`: Other canonical events not otherwise classified.

`kind` is an operator grouping, not a health assessment. `summary` is concise evidence, not a causal diagnosis.

Human `timeline` output uses `TIME | KIND | SUMMARY` for mixed events. If every row is firmware serial output, it uses the streamlined `TIME | SERIAL LOG` layout. Timeline JSON retains the existing canonical response shape.

Timeline accepts either `--hours <number>` or `--since <duration>`. `--since` supports values such as `30m` and `1h` and takes precedence over `--hours`, including the default 24-hour value.

### Serial Reconstruction

```bash
./tools/telemetry serial Boron-soak-1 --since 1h
./tools/telemetry serial Boron-soak-1 --since 1h --follow
./tools/telemetry serial Boron-soak-1 --follow
./tools/telemetry serial Boron-soak-1 --since 1h --include-collector
./tools/telemetry serial Boron-soak-1 --since 1h --grep ERROR
./tools/telemetry serial Boron-soak-1 --since 1h --json
```

`serial` reconstructs cloud-forwarded serial output for one device from existing Timeline/EventHistory data. It is not direct USB/UART capture. The command reuses the same device selector resolution as `device`, `timeline`, and `watch`.

By default, serial rows include only canonical `eventType=serial.log` firmware output. Collector lifecycle records such as `serial.lifecycle.connected`, `serial.lifecycle.disconnected`, and `serial.lifecycle.missing` are excluded. A compatibility rule also recognizes a path-only `/dev/serial/by-id/...` forwarder record as `COLLECTOR` even when the legacy forwarder labeled it `serial.log`. Text output is oldest-first and intentionally log-like:

```text
2026-07-14T11:03:22.100Z  boot complete
2026-07-14T11:03:23.004Z  modem connecting
```

Use `--include-collector` to include both `SERIAL` and `COLLECTOR` records. Combined output shows the kind explicitly:

```text
13:11:07.833  SERIAL     Connect: fail elapsed=660001ms
13:11:08.763  COLLECTOR  Serial device disconnected
13:11:11.646  COLLECTOR  Serial device connected
```

Collector disconnects can be expected when a device resets, sleeps, or USB CDC re-enumerates. A `COLLECTOR` record is operational evidence and does not by itself establish a Serial Forwarder defect.

The command preserves distinct rows by `eventTime + eventId`, with `s3Key` as the event identity fallback. `--since` is required for reconstruction unless `--follow` is used by itself, in which case the command starts from now and prints only new serial lines.

Options:
- `--since <duration>`: Reconstruction window, for example `30s`, `5m`, or `1h`. Required unless `--follow` starts from now.
- `--until <ISO timestamp>`: End timestamp for the initial reconstruction window. Defaults to now.
- `--follow`: Continue watching new serial lines after the initial reconstruction window.
- `--include-collector`: Include Serial Forwarder lifecycle observations and show `KIND` in combined output.
- `--grep <text>`: Include only serial lines containing the given text.
- `--limit <n>`: Maximum serial rows for the initial reconstruction window.
- `--json`: Emit JSON lines with `time`, `line`, `source`, and the original event.
- `--raw`, `--full`: Do not truncate long serial lines.

### Watch Cheat Sheet

```bash
./tools/telemetry watch P2-NewCode-Dev
./tools/telemetry watch P2-NewCode-Dev --since 5m
./tools/telemetry watch P2-NewCode-Dev --interval 3
./tools/telemetry watch P2-NewCode-Dev --serial-only
./tools/telemetry watch P2-NewCode-Dev --types serial,lifecycle,runtime
./tools/telemetry watch P2-NewCode-Dev --exclude serial
./tools/telemetry watch P2-NewCode-Dev --json
./tools/telemetry watch P2-NewCode-Dev --raw
```

`watch` resolves a device name or device ID once at startup, then polls the Timeline API and `DeviceCurrentState`. It displays new activity oldest-first, suppresses duplicates, automatically retries transient API failures, and continues until Ctrl-C. Serial output is near-live cloud-forwarded serial data, not a direct USB serial connection. The startup banner identifies the timezone used for every Timeline and synthesized Ledger timestamp.

Options:
- `--interval <seconds>`: Polling interval. Default is the implemented V1 default. Minimum one second.
- `--since <duration>`: Show recent history before beginning the live watch, for example `5m`.
- `--types <csv>`: Include only selected categories.
- `--exclude <csv>`: Exclude selected categories.
- `--serial-only`: Display only cloud-forwarded serial log events.
- `--json`: Emit machine-readable JSON lines.
- `--raw` / `--full`: Do not truncate long event or serial-log content.

Categories:
- `SERIAL`: Firmware-generated, cloud-forwarded serial logs.
- `COLLECTOR`: Serial Forwarder transport and USB lifecycle observations.
- `TELEMETRY`: Normal device telemetry and published measurements.
- `LIFECYCLE`: Particle webhook event named `status`, including reset-related lifecycle information.
- `RUNTIME`: `device-status` Ledger snapshot changes.
- `DATA`: `device-data` Ledger snapshot changes.
- `WATCHDOG`: Explicit watchdog or fault evidence.
- `EVENT`: Other device events.
- `ERROR`: Other canonical events with error or critical severity.

Firmware development workflow:

```bash
# Terminal 1
./tools/telemetry watch P2-NewCode-Dev --since 2m

# Terminal 2
# Particle firmware build/flash and local development commands
```

This avoids repeatedly issuing `timeline` during firmware testing while still using the deployed telemetry pipeline.

Planned enhancement: `watch` and `timeline` will later share optional terminal color highlighting, respecting non-TTY output and `NO_COLOR`.

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
