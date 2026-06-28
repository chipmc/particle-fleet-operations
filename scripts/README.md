# Particle Log Monitoring Scripts

Local CLI tools for inspecting particle-log-monitoring data.

## Purpose

These tools provide **read-only** access to device telemetry stored in AWS, without modifying deployed infrastructure or data.

## Tools

### Device Timeline Inspector

Query and display chronological device events from DynamoDB.

#### Installation

```bash
cd scripts
npm install
npm run build
```

#### Usage

**Basic query (last 24 hours):**
```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207
```

**Custom time window:**
```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 48
```

**Specific time range:**
```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --start 2026-06-26T00:00:00Z \
  --end 2026-06-26T23:59:59Z
```

**Limit results:**
```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --limit 50
```

**Show raw S3 event data:**
```bash
# Show raw data for all events
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24 --show-raw

# Show raw data for specific event (by index)
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24 --show-raw 3
```

**Use different AWS profile:**
```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --profile my-aws-profile
```

**Specify AWS resources explicitly:**
```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --table InfraStack-ParticleLogEventsTable123ABC \
  --bucket infrastack-rawparticlelogsbucket456DEF
```

#### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --deviceId <deviceId>` | Device ID to query | **Required** |
| `-h, --hours <hours>` | Number of hours to look back | `24` |
| `-s, --start <ISO8601>` | Start time (ISO 8601) | - |
| `-e, --end <ISO8601>` | End time (ISO 8601) | - |
| `-l, --limit <number>` | Max events to return | `100` |
| `-r, --show-raw [index]` | Show raw S3 data (all or specific) | - |
| `-p, --profile <profile>` | AWS profile | `particle-admin` |
| `-t, --table <name>` | DynamoDB table name | Auto-detect |
| `-b, --bucket <name>` | S3 bucket name | Auto-detect |

#### Output Format

The tool displays plain text output (no terminal colors):
- Event name
- Event time (from device)
- Received time (ingestion timestamp)
- Data type
- Firmware version (if available)
- Device name (if available)
- Source type (Particle webhook vs serial forwarder)
- Collector ID (for serial events)
- Log line preview (for serial logs)
- S3 key reference

With `--show-raw`, it also displays the complete raw webhook payload and parsed data from S3.

#### Examples

**Troubleshoot missing events:**
```bash
# Check last 24 hours
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207

# Check specific problem window
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --start 2026-06-26T14:00:00Z \
  --end 2026-06-26T15:00:00Z
```

**Inspect watchdog event:**
```bash
# Find watchdog event and show raw data
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --hours 168 \
  --show-raw
```

**Verify deployment:**
```bash
# Check recent events after deployment
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --hours 1 \
  --show-raw
```

## Testing

```bash
npm test
```

## Development

**Watch mode:**
```bash
npm run watch
```

**Type checking:**
```bash
npm run build
```

## Notes

- This tool is **read-only** and does not modify any AWS resources
- Uses current DynamoDB schema (Phase 1 - no normalization)
- Does not change Lambda behavior or deployed infrastructure
- AWS credentials must be configured for the specified profile
- By default, uses `particle-admin` AWS profile
- Automatically detects table/bucket names from CloudFormation stack `InfraStack`
