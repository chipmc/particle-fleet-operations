# WO-2026-10-19-001: `context` quiet timeline (serial lines counted, not listed)

Owner and approver: Chip. Architect: Claude (app). Controller: Claude Code. Date: 2026-10-19.
Governing doc: docs/AI_DEVELOPMENT_WORKFLOW.md, Working Rules (c) Step 0, (g) tests that can fail,
(h) name the environment, (j) clean worktree, (k) public repo.
Agents: Claude Code on claude-sonnet-5-5 does Step 0, the edit and the tests. Claude Code on
claude-opus-5-5 checks the diff against this WO and commits. Architect does Stage 8; Claude Code then
opens the PR and Chip merges. No deploy: operator CLI only. Follows WO-2026-10-16-004 (#64).
(Called "WO-005" in conversation; the repo name is dated.)

## Goal (plain language)
Chip's live run of `context Boron-Dev-14`: the 25 newest events covered 40 seconds of the 6-hour window,
because a serial-attached device writes a line every second or so. An alert reader needs to see what
the device did over hours. So `context` should show the non-serial events (telemetry, state, collector,
alerts) and only COUNT the serial lines. To read serial lines, use `telemetry serial`. Older-firmware
devices are out of scope (Chip: little value there).

## Changes (tools/telemetry; line numbers read at main 2267ff4)
1. The `context` branch in main() (:103-117): fetch with `limit: TIMELINE_HTTP_MAX_LIMIT` (1000) so the
   window reaches back as far as the API allows, instead of the user's --limit.
2. buildDeviceContext (:1740): compute `sources` from the full fetched events (unchanged logic), then
   split the events: SERIAL (presentEvent kind) are counted, all others kept. Keep the newest
   `options.limit` (default 25) non-serial events for display; `timeline.count` and `events` reflect
   what is shown. Add `serialLines` (number) to the returned `timeline` object (additive; the four
   top-level JSON keys stay).
3. outputDeviceContext (:1751): after the Sources line print one line:
   `Serial: <n> lines in the fetched range (see: telemetry serial <name> --since 6h)`; omit it when n is 0.
   When the fetch hit the 1000 cap, also print one stderr line: `WARN: fetched back to <oldest event
   time> only (1000-event cap); earlier events not shown.`
4. Exit code 3 only when the non-serial rows were cut by --limit (as today for the shown rows). The cap
   warning does not change the exit code (a serial-attached device would always exit 3).
5. help text for `context` (:304-): one line saying serial lines are counted, not listed.
6. docs/tools.md: update the Device Context paragraph and regenerate the example from the renderer.

## Budget
tools/telemetry: at most +25 net (firmware-style src lines matter most; ask Chip before any raise).
tools/telemetry.test.js: at most +40 net. docs/tools.md: at most 10 changed lines. Closing note at most
8 lines with budget versus actual. Any raise needs Chip's OK with the reason.

## Step 0 (before any edit; rule c)
Report in the commit message, at most 12 lines: (1) what fetchTimeline returns with limit 1000 on both
paths (HTTP and DynamoDB) and what `truncated` means there (annotateTimelineHttpPayload :1001-1015;
queryTimelineFromDynamo); (2) the exact newest-first order of `events`, so "oldest fetched" is the last
element; (3) whether any other event kind is as chatty as SERIAL (check COLLECTOR and TELEMETRY rates in
the fixtures or code) and whether filtering only SERIAL is enough; (4) whether fetching 1000 events for
a device with no serial data changes cost or latency noticeably. Stop and tell Chip if +25 cannot hold or
if (3) shows SERIAL-only filtering is not enough.

## Tests (rule g)
Must be able to fail. Cases: 30 SERIAL plus 3 TELEMETRY events show 3 rows and `Serial: 30 lines`; no
SERIAL events print no Serial line; `sources` still lists Serial when serial events were filtered out of
the display; non-serial rows beyond --limit set the truncation exit path (existing helper); the cap
warning appears when the fetch returned 1000 events; JSON `timeline.serialLines` is a number and the
top-level keys are still the same four. Run `node --check tools/telemetry` and
`node --test tools/telemetry.test.js` and name the environment (rule h). Claude Code does not run the
live command; Chip does (Boron-Dev-14: expect the window to show telemetry and collector rows across
hours and a serial count).

## Out of scope
A server-side event filter in the Lambda (the clean long-term fix: needs a deploy; backlog), listing
serial lines in `context`, any older-firmware change (firmware field, Attention wording), `fleet`,
`timeline`, JSON top-level keys, thresholds.

## Closing note (2026-10-19): shelved, not built
Step 0 (Claude Code) found the 1000-event cap covers only about 27 minutes of a serial-attached device
(about 1.6 s per event on Boron-Dev-14), so a client-side filter cannot reach back hours; paging back
(about 14 requests) or a server-side filter (Lambda deploy) would be needed. Chip decided to shelve:
only a tiny fraction of devices will have the serial log forwarder, field devices have no serial
lines, and for them the 25-event default already covers hours. No code changed; budget used: 0.
The server-side event filter stays in docs/backlog.md (alert redesign section), bench devices only.
Revisit if field devices ever carry a forwarder.
