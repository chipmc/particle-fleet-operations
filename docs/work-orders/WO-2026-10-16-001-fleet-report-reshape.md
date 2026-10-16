# WO-2026-10-16-001: Reshape the `fleet` text report

Owner and approver: Chip. Architect: Claude (app). Controller: Claude Code. Date: 2026-10-16.
Governing doc: docs/AI_DEVELOPMENT_WORKFLOW.md, Working Rules (c) Step 0, (g) tests that can fail,
(h) name the environment, (j) clean worktree and fresh `npm ci`, (k) public repo.
Agents: Claude Code on claude-sonnet-5-5 does Step 0, the edit and the tests. Claude Code on
claude-opus-5-5 checks the diff against this WO and commits. Architect does Stage 8; Claude Code then
opens the squash PR and Chip merges. No deploy: operator CLI only.

## Goal (plain language)
`telemetry fleet` is (1) a reference for device names, IDs and when each device next reports, and
(2) the place where connectivity problems stand out and say what kind of problem they are. It stays
one Particle product. No health score yet (the tool says it does not infer health; the backlog wants
an evidence-based model first). Remove what is identical on every row.

## Changes (text output, tools/telemetry; line numbers read at 6b667f2)
1. Default table: NAME | DEVICE ID | FIRMWARE | SOC | CLOUD | NEXT REPORT | LAST HEARD | STATUS,
   sorted by name. Drop CS, RT, DD, RUNTIME and DEVICE OS (fleetSummaryTextRow :1445, columns
   :1434-1436). `--verbose` keeps its extra columns and gains DEVICE OS. EXPECTED becomes NEXT REPORT.
2. STATUS comes only from existing fields: OVERDUE (expectationStatus overdue), UNKNOWN (expectation
   unknown), otherwise OK. No new inputs and no health wording.
3. Header: replace the Schema and Generated lines with one "Generated: <local time> <zone>" line, and
   add one count line from STATUS ("9 OK · 1 OVERDUE · 0 UNKNOWN"). Overview: :1476-1500.
4. Overview sections: show COVERAGE only when coverage is incomplete; show DEVICE OS only when more
   than one version is present. CLOUD, FIRMWARE and BATTERY SOC stay.
5. Attention: the overdue observation (:1624) states the case and its evidence: "Overdue 46 minutes ·
   cloud offline|online · last heard 1 hour ago · last report HH:MM". The other observations stay
   (missing Current State, Runtime status or Device Data, serial activity, SOC age); they are how the
   absence of CS, RT and DD is still reported.
6. Recent Activity off by default: DEFAULT_FLEET_ACTIVITY_LIMIT (:22) becomes 0 and the section is
   skipped when empty; `--activity-limit N` still turns it on.
7. Help text (:206-250) and the Fleet Summary section of docs/tools.md (:118-) match, example included.

Unchanged: the `fleet-summary.v1` JSON. No field is removed or renamed; additive fields are allowed
(per-device `reportingStatus`, status counts). `recentActivity` is [] by default (item 6).
No Lambda, API or AWS change.

## Budget
tools/telemetry: at most +30 net (expected negative). tools/telemetry.test.js: at most +40 net; the
reviewer sets fixture sizes. docs/tools.md: at most 30 changed lines. Record budget versus actual in
the closing note. Any raise needs Chip's OK with the reason.

## Step 0 (before any edit; rule c)
Report in the commit message, at most 20 lines: the full set of expectationStatus values (:1215,
:1238, :1257); every test asserting a removed column, the Schema or Generated lines, Recent Activity
or the coverage and OS sections (about 12 fleet tests as found in Step 0, not 30); that nothing else
consumes the text or JSON output (grep found only tests); and whether a local-zone time helper exists.
Stop and tell Chip if the budget cannot hold.

## Architect decisions after Step 0 (2026-10-16)
1. Sort by name only in renderFleetSummary; the JSON device order is unchanged.
2. "Last report" = lastApplicationReportAt, omitted if absent; HH:MM if today, else MM-DD HH:MM.
3. One new local-time helper, with the short zone name, for "Generated" and "last report".
4. Budgets unchanged; stop and report before exceeding the test budget.
5. STATUS OK maps to expectationStatus upcoming (values: unknown, upcoming, overdue).

## Tests (rule g)
Must be able to fail. Cases: STATUS overdue with cloud online, overdue with cloud offline, OK while
offline and not yet due, unknown; name sort; one versus mixed Device OS; complete versus incomplete
coverage; activity off by default and on with `--activity-limit`. Run `node --check tools/telemetry`
and `node --test tools/telemetry.test.js` and name the environment (rule h). Claude Code does not run
the live command: it needs the Particle access token, which this WO does not authorize. Chip runs
`telemetry fleet` himself after merge.

## Out of scope
Health score, multi-product view, a problems-only flag, a per-device detail command, the e-paper
dashboard, and any server-side change.
