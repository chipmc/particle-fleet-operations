AGENT: Claude Code · MODEL: claude-sonnet-5-5 (docs-only edit; probe it with a one-line call first per rule (e), fall back to claude-opus-5-5 if the probe fails) · REASONING: medium
AUTHORIZATION SCOPE: edit `docs/AI_DEVELOPMENT_WORKFLOW.md` on a new branch, commit by name, push the branch; open the PR only after the architect's Stage 8 OK. Not authorized: merge, any other file, any AWS call.

# WO-2026-10-13-001 — add Working Rule (k): this repository is public

Governing: `docs/AI_DEVELOPMENT_WORKFLOW.md` "Working Rules (adopted 7–8 October 2026)", rules (a) records/PR, (b) small WOs, (c) Step 0. Plain goal: write down, as one rule, what keeps a public repo safe, so every agent and Chip follow it without being told each time.

Why: chipmc/particle-fleet-operations is public (Chip's decision, 2026-10-13). On 2026-10-11 GitGuardian flagged a literal `--api-key <id>` command line in a pushed dispatch (a key ID, a false positive), and a scan found the home IP in a runbook entry (since redacted). No credential was ever found in the files or history.

## Budget (stop and report if over)
- `docs/AI_DEVELOPMENT_WORKFLOW.md`: at most +7 net lines. Source, tests, other docs: 0.

## Step 0 (rule c), at most 10 lines
Re-check on main: (j) is the last rule in the Working Rules section; the sentence "The letters match the firmware's." exists and where; no (k) already exists; nothing in the workflow doc contradicts the rule below. Ends with PROCEED or STOP.

## The edit (exact text; do not reword)
1. In the intro sentence, replace "The letters match the firmware's." with "Letters (a)–(j) match the firmware's; (k) is fleet-ops only."
2. After rule (j), add:

(k) Public repo. This repository is public. Records, dispatches, reports and commit messages carry
names, IDs and counts only: never a key or secret value, an IP address or a personal contact
detail, and never a command line with a literal credential option (write "get-api-key for key a,
no value flag", not `--api-key <id>`). Account IDs and the alert email stay only where the code
needs them. The detect-secrets hook is a backstop, not a substitute for this rule.

## Report to the architect (stop here, at most 15 lines)
Branch `wo/2026-10-13-001-public-repo-rule` from main; Step 0 result; the `git diff` (it should be about +7); line budget versus actual. Commit the WO file and the edit by name and push the branch. Then stop for Stage 8; do not open the PR yet. Chip merges after the PR.
