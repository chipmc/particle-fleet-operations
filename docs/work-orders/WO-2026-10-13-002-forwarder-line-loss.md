AGENT: Claude Code · MODEL: claude-opus-5-5 (log analysis across AWS tables and the forwarder code; probe it first per rule (e)) · REASONING: high
AUTHORIZATION SCOPE: read-only AWS (DynamoDB Query/GetItem, S3 list/get, CloudWatch Logs and metrics, API Gateway and Lambda metrics). No writes, no deletes, no `--include-value`, no Particle operator token. No code changes. Record the report on a new branch by name; no PR.

# WO-2026-10-13-002 — where does the serial forwarder lose lines? (investigation only)

Governing: `docs/AI_DEVELOPMENT_WORKFLOW.md` Stage 2 (Evidence Collection), Working Rules (c) Step 0, (f) reports ≤150 lines, (h) name the environment on every verification, rule (k) if merged (public repo: names, IDs and counts only, no values, no IPs). Raised by the firmware thread, relayed by Chip. Plain goal: find which stage loses the lines, with evidence, before anyone proposes a fix.

## The report from firmware
- 2026-10-13 06:00–07:00 SGT (= 2026-10-12 22:00–23:00 UTC), Boron-Dev-09, firmware v41: AWS holds only 67 serial lines for the hour. Missing: `ConfigHold: ended …`, `LedgerCallback: kind=input …`, `Config: …`, although the device's behaviour shows the change landed.
- 2026-10-09 06:27 UTC flood: about 100 lines/s from the device, about 1 line/s reached AWS (evidence record `WO-2026-10-10-001-evidence.md`, §2, §8a).

## What we already know (re-verify, do not re-derive)
- The forwarder (`local-serial-log-forwarder`, `src/serial_reader.py` at e27bce8) does one blocking POST per line, 3 s timeout, no retry, a failed line is printed and dropped; one thread per device; no application buffer (evidence §8a). About 0.86 s per line, so a sustained ceiling near 1.2 lines/s per device. Not measured: the OS/pyserial input buffer size.
- AWS side: no per-device rate check or dedupe in the Lambda (evidence §8b); serial plan `t3oq8d` is 10 req/s, burst 50, never approached; no 429s Oct 2–10 (§4, §8c).
- A new forwarder (with the AWS-only flood collapse) went live 2026-10-11 05:18 UTC. The Oct 13 hour is after it; the Oct 9 flood was before it. Step 0 must establish the commit now running, as far as AWS and Chip can show.
- Dev-09 cycles connect/missing about every 10 minutes (Oct 11→12: 144 connects, 138 missing). A cycle can be seconds long (12:15:26 CONNECTED, 12:15:30 MISSING on Oct 12). Lines the device emits while the port is absent never reach the forwarder.

## Hypotheses to separate, in the order to test
1. Device not on serial: the lines were emitted while Dev-09 was MISSING.
2. Lost before upload: serial read or buffer overflow on the Pi (merged lines, fragments, uptime gaps).
3. The new collapse step suppressed or held distinct lines (a defect, not a rate limit; 67 lines per hour is far below any rate cap).
4. Upload failed: POST timeout or non-2xx, line dropped.
5. AWS rejected or overwrote rows (4xx/5xx, Lambda errors, same-timestamp key collision).

## Step 0 (rule c), ≤20 lines, then continue
Re-check the cited code and evidence sections still hold; state the forwarder commit in use if any record shows it (`git log` of that repo is not available here: say so). PROCEED unless the data below cannot be read.

## AWS evidence for the window 2026-10-12 22:00–23:00 UTC, Boron-Dev-09 (production, read-only)
1. Serial rows: count, first/last time, per-minute counts; text patterns present (`ConfigHold`, `LedgerCallback`, `Config:`) in this window and in ±1 h around it.
2. Lifecycle: every CONNECTING/CONNECTED/DISCONNECTED/MISSING in the window; total seconds CONNECTED. Tests hypothesis 1: are the missing lines inside MISSING gaps?
3. Quality of what did arrive: merged lines, fragments, uptime-prefix gaps (device uptime delta versus forwarder time), as in evidence §2.
4. Upload and AWS health for the hour: API Gateway 4xx/5xx and latency on the serial key, Lambda errors, any rows with identical `eventTime` for this device.
5. Compare with a control: Boron-soak-1's rows for the same hour (volume and gaps).
6. Restate the forwarder's sustained and burst rates from evidence (no new claim unless measured).

## Chip: two read-only checks on the Pi (the decisive split)
The local log keeps every line the forwarder read (the collapse is AWS-only). On the Pi, for Dev-09's file under `/var/log/serial-forwarder/` and the same hour (mind the Pi's timezone):
- count the lines, and grep for `ConfigHold: ended`, `LedgerCallback: kind=input`, `Config:`;
- read `journalctl -u serial-forwarder` for the hour for any failed or timed-out post messages, and note the service start time.
Present in the local file but absent in AWS means hypotheses 3–5. Absent in both means 1–2. Chip sends the counts back; no file contents are needed.

## For the forwarder repo's agent (Chip relays; separate repo, its own workflow)
- Say which commit is deployed on the Pi and show the collapse step's key and flush rules against the three missing line types (do any of them share a key with a neighbour?).
- Measure or state the OS/pyserial input buffer size and how many 182-character lines it holds.
- Do not change code until the split above is known.

## Reporting
At most 150 lines, IDs and counts only, each result tagged with its environment. End with a one-line verdict per hypothesis (confirmed, ruled out, not testable here) and what would settle the rest. Do not propose the fix here; the architect and the forwarder agent decide it after the split. Budget: 0 lines of code.
