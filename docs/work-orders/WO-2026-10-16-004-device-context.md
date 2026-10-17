# WO-2026-10-16-004: `telemetry context` (one-device alert context)

Owner and approver: Chip. Architect: Claude (app). Controller: Claude Code. Date: 2026-10-16.
Governing doc: docs/AI_DEVELOPMENT_WORKFLOW.md, Working Rules (c) Step 0, (g) tests that can fail,
(h) name the environment, (j) clean worktree, (k) public repo.
Agents: Claude Code on claude-sonnet-5-5 does Step 0, the edit and the tests. Claude Code on
claude-opus-5-5 checks the diff against this WO and commits. Architect does Stage 8; Claude Code then
opens the PR and Chip merges. No deploy: operator CLI only. Follows WO-2026-10-16-003 (#63).

## Goal (plain language)
When an alert fires for a device (Ubidots to Slack `#iot-alerts`), a person should be able to type one
command and see what fleet-ops knows about that device: its status, what looks wrong, what it did
recently, and which data sources that answer used. This is the hand-run first step toward enriching
alerts. It must reuse what exists and add as little code as possible. Pilot devices are the 11 test
devices (product 42131), tagged `enrich-pilot` in Ubidots by Chip. This WO does not touch Ubidots or Slack.

## Command
`./tools/telemetry context <name-or-device-id> [--product-id <id>] [--since 6h | --hours <n>] [--limit <n>] [--json]`

(`device` already exists and prints the raw current-state record, so it is not changed.) Text output,
in this order:
1. Header: `Context: <name> (<device id>) · <local stamp>`.
2. One status line: STATUS (as in `fleet`), next report, last heard, firmware, SOC, cloud state.
3. Attention: this device's observations from `buildFleetAttention`, or `Attention: none`.
4. Sources line: `Sources: Particle cloud, Ledger, Serial`, listing only those that returned data for
   this device (Particle cloud = product inventory; Ledger = runtime status projection; Serial = any
   timeline event of kind SERIAL in the window). Old-firmware devices will show `Particle cloud` only.
5. The timeline table as `timeline` prints it (reuse `outputTimeline`). Default window 6h, limit 25. Exit code: as `timeline` when the limit truncates (Chip OK 2026-10-17).
`--json`: one object `{ device, attention, sources, timeline }` using the existing shapes. No new schema.

## Changes (tools/telemetry; line numbers read at main 08c2102)
1. Add `context` to `COMMANDS` (:36), usage (:143), and the per-command help (:190).
2. In `main()` after the `device` branch (:~86): resolve the device as `device` does (requireSelector,
   loadDeviceInventory, resolveDeviceSelector), call `buildFleetSummary(devices, {productId})` on the full loaded inventory and pick this
   device's summary entry and attention (Step 0: a one-device list drops "Device Data not observed", so
   `context` would disagree with `fleet`; Chip decided 2026-10-17), call `fetchTimeline` as `timeline` does, then print. Reuse
   `fleetReportingStatus`, `formatLocalStamp`, `formatFleetAttention`, `outputTimeline`.
3. If a small helper is needed (sources, status line), keep it to one function, about 15 lines.
4. docs/tools.md: one short section with a real example run by the renderer, not hand-typed.

## Budget
tools/telemetry: at most +60 net (firmware-style src lines matter most; stop and ask Chip before any
raise). tools/telemetry.test.js: at most +60 net. docs/tools.md: at most 20 lines. Record budget
versus actual in a closing note, at most 8 lines.

## Step 0 (before any edit; rule c)
Report in the commit message, at most 12 lines: (1) whether `buildFleetSummary` with a single device
returns the same attention and status as the full-product run for that device (it should not depend on
the other devices); (2) how to tell Ledger present from absent per device (`coverage.runtimeStatus`?) and
Serial present from the timeline events; (3) whether `fetchTimeline` needs the whole product inventory
or just this device, and the cost of `loadDeviceInventory` for one command; (4) the exact SERIAL kind
value from `presentEvent`. Stop and tell Chip if the +60 budget cannot hold.

## Tests (rule g)
Must be able to fail. Cases: a device with Ledger and Serial data lists both sources; a device with only
cloud data lists `Particle cloud` alone; an overdue device shows its Attention line; a healthy device
shows `Attention: none`; unknown selector fails with the existing error; `--json` has the four keys.
Run `node --check tools/telemetry` and `node --test tools/telemetry.test.js` and name the environment
(rule h). Claude Code does not run the live command; Chip does.

## Out of scope
Any Ubidots or Slack access, alert history, grouping of repeats, writing anywhere, AI summaries,
changing `device`, `fleet`, JSON schemas, or thresholds. The Ubidots-ID versus Particle-ID question is
Chip's: the command takes the Particle device ID or the device name.

## Closing note (2026-10-17, branch wo-2026-10-16-004-device-context)
Budget versus actual: tools/telemetry +57 net (limit +60); tools/telemetry.test.js +29 net (limit +60);
docs/tools.md 22 lines (limit 20, raised to 22 with Chip's OK: the real rendered example is 15 lines).
Decisions: summary built from the full inventory so Attention matches `fleet`; 6h default window when
--since, --start and --hours are absent; exit 3 on truncation as `timeline`.
Tests: node --check clean; node --test 217 tests, 210 pass, 0 fail, 7 skipped (Node v26.3.0, macOS);
the context test fails if the Serial or Ledger source logic is broken. Live run is Chip's.
Not unit-tested (inside main(), needs live backends): the 6h default and the exit code.
Opus check found one defect, fixed: a silent device with no webhook secret failed with "No data found"; the context fetch now passes allowEmpty.
