# WO-2026-10-16-002: Make the `fleet` text report vertically compact

Owner and approver: Chip. Architect: Claude (app). Controller: Claude Code. Date: 2026-10-16.
Governing doc: docs/AI_DEVELOPMENT_WORKFLOW.md, Working Rules (c) Step 0, (g) tests that can fail,
(h) name the environment, (j) clean worktree and fresh `npm ci`, (k) public repo.
Agents: Claude Code on claude-sonnet-5-5 does Step 0, the edit and the tests. Claude Code on
claude-opus-5-5 checks the diff against this WO and commits. Architect does Stage 8; Claude Code then
opens the squash PR and Chip merges. No deploy: operator CLI only. Follows WO-2026-10-16-001 (#61).

## Goal (plain language)
The report grows by one row per device, so everything else must stay short. The CLOUD, FIRMWARE and
BATTERY SOC blocks repeat what the table already shows. Remove them, and tighten the rest. The
`fleet-summary.v1` JSON does not change (it keeps connected, distributions, batterySoc and coverage).

## Changes (text output, tools/telemetry; line numbers read at main 3dca12f)
1. Remove the overview block: the call at :1424 and the helpers only it uses (formatFleetOverview
   :1475, buildFleetOverviewSections :1481, formatHorizontalOverview :1527, formatStackedOverview
   :1539, formatCompactCoverage :1579, formatDeviceDataCoverage :1584, and any others Step 0 finds
   unused). The conditional COVERAGE and DEVICE OS sections go too: missing evidence is already an
   attention line, and a Device OS rollout gets its own view later. Keep buildBatterySocOverview and
   buildDistribution (JSON uses them).
2. Header: one line, "Fleet Summary: Product 42131 · 10-16 12:42 GMT+8 · 11 OK · 0 OVERDUE · 0 UNKNOWN".
   The separate Generated and count lines go.
3. Attention (architect addition, strike it if you disagree): one line per device,
   "Name: first observation / second observation", under a heading "Attention (N)". With none,
   a single line "Attention: none". No underline, no blank line between devices.
4. One blank line between header, attention and table, and none elsewhere.
5. Help text and the Fleet Summary section of docs/tools.md match, including the example output.

## Budget
tools/telemetry: at most 0 net (expected about -100, since this mostly deletes). tools/telemetry.test.js:
at most +10 net. docs/tools.md: at most 25 changed lines (count replaced lines). Record budget versus
actual in a closing note in this file, at most 10 lines. Any raise needs Chip's OK with the reason.

## Step 0 (before any edit; rule c)
Report in the commit message, at most 20 lines: that #61 is on main; which helpers become unused
(check terminalWidth :1556 and printDistribution :1471 for other callers before deleting); every test
touching the overview, the attention layout or the title lines (about :2035, :2118-2119, :2170-2194
and the empty-attention cases); and that nothing else reads the removed text. Stop and tell Chip if a
budget cannot hold.

## Tests (rule g)
Must be able to fail. Cases: no CLOUD, FIRMWARE, BATTERY SOC, COVERAGE or DEVICE OS block in text; the
one-line header with counts; attention as one line per device, with several observations and with
none; JSON still contains connected, distributions, batterySoc and coverage with unchanged values. Run
`node --check tools/telemetry` and `node --test tools/telemetry.test.js` and name the environment
(rule h). Claude Code does not run the live command (it needs the Particle access token); Chip does.

## Out of scope
A rollout or Device OS view, health score, multi-product view, JSON changes, any server-side change.

## Closing note (2026-10-16, branch wo-2026-10-16-002-fleet-report-compact)
Budget versus actual: tools/telemetry -134 net (limit 0); tools/telemetry.test.js -22 net (limit +10);
docs/tools.md 18 replaced lines, 15 added (limit 25, replaced lines count).
Pre-existing dead code deleted with the overview chain (Chip's decision 3): printDistribution,
formatDistribution, the unused `inventory` constant in renderFleetSummary, and formatCountBlock,
formatCoverage, formatPercent (their only callers were removed). terminalWidth went too; the
`terminalWidth` render option is now ignored (tests still pass it harmlessly).
Tests: node --check clean; node --test 214 tests, 207 pass, 0 fail, 7 skipped (Node v26.3.0, macOS);
5 tests fail against the old tools/telemetry. No package.json, so no npm ci. Live run is Chip's.
JSON unchanged. The blank line before Recent Activity stays (heading and underline kept). Attention (N) counts devices; Recent Activity keeps its heading and underline.
