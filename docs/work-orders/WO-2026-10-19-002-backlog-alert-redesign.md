# WO-2026-10-19-002: Backlog entry for alert redesign and enrichment (docs only)

Owner and approver: Chip. Architect: Claude (app). Controller: Claude Code. Date: 2026-10-19.
Governing doc: docs/AI_DEVELOPMENT_WORKFLOW.md, Working Rules (g) tests that can fail (n/a: docs only),
(j) clean worktree, (k) public repo (no URLs with secrets, no tokens, no contact details).
Agents: Claude Code on claude-sonnet-5-5 makes the edit and commits. No Opus check (docs only).
Architect does Stage 8; Claude Code then opens the PR and Chip merges. Run after WO-2026-10-19-001 is
merged, or on its own branch from main if that is not yet merged.

## Goal (plain language)
Record Chip's decisions of 2026-10-19 so they are not lost: the Slack alerts change when the new
firmware rolls out, and alert enrichment is previewed on the pilot devices first.

## Change
docs/backlog.md: add one section `## Alert redesign and enrichment (at new-firmware rollout)` between
"Phase 5" and "Completed", with these bullets (tighten wording; keep facts):
- Decision (Chip, 2026-10-19): rotate the Slack incoming webhook used by the Ubidots events when the new
  firmware rollout starts and the alert events are redesigned; not before.
- Redesign alerts from `fleet` status (OVERDUE, UNKNOWN) and the firmware `alerts` codes, not fixed
  "offline for N hours" thresholds, which are wrong for sleeping devices.
- Every alert message carries the Particle device ID (the Ubidots device label); the "reconnected"
  message currently has the name only.
- Stale E01 alerts: the `3h-flag` variable can go 1 then 0 within seconds while Slack still posts;
  check current status before posting. Collapse repeats per device.
- Event definitions copied in Ubidots have labels that do not match their names; match events by ID.
- Enrichment: read-only Ubidots MCP plus `telemetry context` (join key: Particle device ID = Ubidots
  label). Stage: pilot on devices tagged `enrich-pilot` (GCC test fleet plus one older device); then
  in-thread enrichment; AI summary last. Any posting back uses its own narrowly scoped token and a
  separate approval.
- Add a server-side event filter (exclude serial) to the Timeline API so `context` can reach back
  further (needs a Lambda deploy).
- Older firmware has no Ledger, serial or Particle-log data: Ubidots is the only rich source there;
  `telemetry context` adds little for it.

## Budget
docs/backlog.md: at most 24 lines added, nothing removed. No other file. Closing note at most 4 lines.

## Out of scope
Any code change, any Ubidots or Slack change, rotating the webhook.

## Closing note (2026-10-19, branch wo-2026-10-19-002-backlog-alert-redesign)
Budget versus actual: docs/backlog.md 14 lines added, 0 removed (limit 24); no other file besides this WO.
Docs only: no tests, no Opus check, no code. Rule (k): no URLs, tokens or contact details added.

