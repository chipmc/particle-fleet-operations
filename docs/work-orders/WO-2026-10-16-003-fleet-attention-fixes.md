# WO-2026-10-16-003: Fleet attention fixes (singular units, schedule-aware SOC age)

Owner and approver: Chip. Architect: Claude (app). Controller: Claude Code. Date: 2026-10-16.
Governing doc: docs/AI_DEVELOPMENT_WORKFLOW.md, Working Rules (c) Step 0, (g) tests that can fail,
(h) name the environment, (j) clean worktree, (k) public repo.
Agents: Claude Code on claude-sonnet-5-5 does Step 0, the edit and the tests. Claude Code on
claude-opus-5-5 checks the diff against this WO and commits. Architect does Stage 8; Claude Code then
opens the PR and Chip merges. No deploy: operator CLI only. Follows WO-2026-10-16-002 (#62).

## Goal (plain language)
Two things Chip saw in the live report. (1) "Overdue 1 hours" should read "1 hour". (2) A field device
that sleeps overnight and is on schedule must not appear under Attention just because its battery
reading is more than 6 hours old: with a quiet window of about 7 hours, every device would be flagged
every night and Attention would stop meaning anything as the fleet grows.

## Changes (tools/telemetry; line numbers read at main 29f6d0c)
1. formatLongRelativeDuration (:1652): write "1 hour" and "1 minute" in the singular. Other values
   unchanged. It is used by the attention lines at :1482 and :1498-1501.
2. SOC age (:1488-1490): add the "Last reported SOC ... / SOC observation is ... old" observation only
   when expectationStatus is not `upcoming`, that is, when the device is overdue or its schedule is
   unknown. The 6-hour threshold stays. The SOC column and the JSON are unchanged.
   Architect's default; Step 0 may propose a simpler rule that does the same job, and Chip decides.
3. docs/tools.md: update the sentence about stale SOC evidence (the Attention paragraph) to say it
   applies only to devices not on schedule, and fix any "1 hours" example text.

## Budget
tools/telemetry: at most +6 net. tools/telemetry.test.js: at most +12 net. docs/tools.md: at most 6
changed lines. Record budget versus actual in a closing note in this file, at most 8 lines. Any raise
needs Chip's OK with the reason.

## Step 0 (before any edit; rule c)
Report in the commit message, at most 12 lines: every test or doc line that contains "1 hours",
"1 minutes" or the stale-SOC text (about :2011-2025 in the tests); which devices in existing fixtures
have an SOC age over 6 hours and which expectationStatus they carry; and whether
expectationStatus is always set on the summary device when the schedule is unknown. Stop and tell
Chip if a budget cannot hold.

## Tests (rule g)
Must be able to fail. Cases: "1 hour" and "1 minute" singular, "2 hours" and "2 minutes" plural;
SOC older than 6 hours with status `upcoming` is not in Attention; the same with `overdue` and with
`unknown` is; a fresh SOC never is. Run `node --check tools/telemetry` and
`node --test tools/telemetry.test.js` and name the environment (rule h). Claude Code does not run the
live command; Chip does.

## Out of scope
Flagging a device that reports on schedule but never updates its SOC, a combined overdue-plus-SOC
line, and any change to thresholds, JSON or columns.

## Closing note (2026-10-16, branch wo-2026-10-16-003-fleet-attention-fixes)
Budget versus actual: tools/telemetry +1 net (limit +6); tools/telemetry.test.js +33 net (limit +12,
raised to +33 with Chip's OK: the five SOC cases need five devices); docs/tools.md 1 line (limit 6).
Rule 2 is expectationStatus !== 'upcoming' (Chip's decision). Out of scope, not flagged: a device on
schedule whose SOC is stuck. Tests build 'upcoming' through buildFleetSummary, not a hand-set status.
Tests: node --check clean; node --test 216 tests, 209 pass, 0 fail, 7 skipped (Node v26.3.0, macOS);
the 2 new tests fail against the old logic. Live run is Chip's.
