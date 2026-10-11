AGENT: Claude Code · MODEL: claude-opus-5-5 · REASONING: high
AUTHORIZATION SCOPE: read-only AWS (no `--include-value`, no Particle operator token), local worktree, tests, records and PR commits added by name, push, open a PR. Not authorized: merge, deploy, any AWS write, printing or reading any key/secret value, reading the ingestion function's environment (it holds two secrets).

# WO-2026-10-06-001 deploy 3 — delete the old Particle Cloud webhook key a (`mqdbypomt7`), then close the WO

Governing: `docs/AI_DEVELOPMENT_WORKFLOW.md` Stages 6–9 and Working Rules (a) records/PR, (c) Step 0, (f) reports ≤150 lines, (g) mutation check, (h) name the environment on every verification, (i) increments with an observation gate, (j) clean worktree, fresh `npm ci`, exact `cdk.out`. Plain goal: remove the retired key so the registry is back to one key per consumer (key b is primary), and finish the rotation's records.

State on 2026-10-11 (from `WO-2026-10-06-001-deploy2-status.md`, PR #55): key a `mqdbypomt7` disabled since 2026-10-10 09:20 UTC, 0 requests through the 24 h watch; key b `mug6eyfk1l` and serial `2eisotew77` enabled, all 200; checker 09:00 UTC run healthy. Particle's org secret already holds key b.

## Budget (stop and report if over; a raise needs Chip)
- `config/ingestion-consumers.json`: −4 net (`primarySlot` "a"→"b", rotation block removed). Source code: 0 lines.
- Deploy 3 status record ≤60 lines; closing record ≤80; runbook incident-history entry ≤10; `docs/next-steps.md` ≤6.

## Chip first
Merge PR #55. If main does not contain 54cb161, stop and tell Chip.

## Step 0 (rule c) — report ≤80 lines, then wait for the architect
1. Re-check on main: the registry (key a `primarySlot:"a"`, rotation block `phase:"old-disabled"`), `infra/lib/infra-stack.ts` key loop (~807–836: slots, `enabled`, primary and rotation env vars), `infra/lib/ingestion-consumers.ts:19–95` schema; the checker's handling of a consumer with no rotation. Cite file:line.
2. Production, read-only: key a still disabled; zero key-a requests in the access log from 2026-10-10 09:20 UTC to now; keys b/serial still 200; plan `fef2gk` lists a and b.
3. Say whether anything else in the registry or code refers to key a's ID or name.

## Build (clean worktree from main, new branch `wo/2026-10-06-001-deploy3`)
1. Fresh `npm ci` in the worktree; edit the registry; run lambda and infra suites. Expect the deploy 2 counts (lambda 355, infra 65) because WO-2026-10-08-001 made tests state-independent; report any difference.
2. `cdk diff` against live InfraStack, and compare the new bundles against the deployed zips (registry content is the only expected difference in both functions).
3. Expected diff, exactly:
   - [-] slot a ApiKey (logical ID ending `A4BA5483`) and its UsagePlanKey.
   - [~] ingestion Lambda environment: `INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK` now resolves to key b; `INGESTION_API_KEY_ROTATION_ID_PARTICLE_CLOUD_WEBHOOK` removed.
   - [+] new Lambda Version, old one orphaned and retained; `prod` alias moves.
   - [~] code assets of the ingestion function and the rotation checker.
   - Not in the diff: key b, the serial key, plans `fef2gk` and `t3oq8d`, alarms, IAM.
   Anything else (a replace, another delete, IAM, an extra resource) is a stop: send the diff to the architect, do not proceed.
4. Report to the architect for Stage 8 with the Security Gate lines (no plaintext secrets; no IAM change; the only destructive operation is deleting key a, which is intended). Keep the exact `cdk.out`.

## After the architect's Stage 8 OK
Commit the config change and `WO-2026-10-06-001-deploy3-status.md` by name, push, open the PR (squash; do not merge). Tell Chip the worktree `infra` path; Chip deploys with `npx cdk deploy InfraStack --app cdk.out` and reports the finish time.

## Post-deploy (production) — record each result with its environment
1. Stack `UPDATE_COMPLETE`; `cdk diff --app cdk.out` shows "There were no differences".
2. `aws apigateway get-api-key --api-key mqdbypomt7` (no `--include-value`) returns NotFound; key b and serial `enabled:true`; plan `fef2gk` lists only key b.
3. Ask Chip to trigger one report each from Dev-14 and Dev-09 (his device operation). Expect 200s on key b with `authResult: success` in the `ingestion_auth` log lines; serial key 200s continue. This is what shows the primary variable now points at key b. Do not read the function environment.

## Observation gate (rule i), through the 2026-10-12 09:00 UTC checker run
Key b and serial all 200; no new 401/403 on `POST /particle/log`; checker: `consumersChecked: 2`, no overdue, no inconsistencies, `publishFailures: 0`, no SNS publish, alarm OK. Report to the architect.

## Close-out (after the gate passes, same PR, ≤ the budgets above)
- Closing record `WO-2026-10-06-001-closing.md`: one row per step of the whole rotation (foundation, mechanism, health, alarm, workflow, test fix, deploys 1–3), budget versus actual with any raise and its reason, and these misses stated plainly, wording taken from your own records: (1) about 14 minutes of failed AWS webhook deliveries after the first paste into the Particle org secret, caused by a trailing carriage return that the architect's `| pbcopy` copy command added (Ubidots received the data; fixed by `tr -d '\r\n'`); (2) the deploy windows were not exercised live (deploy 1: 35 s, deploy 2: 25 s, no request inside either); (3) the zero-use gate check ran 80 seconds after the gate closed. The watchdog event type did arrive on key b (deploy 1 record, 10-10 00:00:44 UTC), so there is no relaxed gate to record; if your own records show any other miss, list it.
- Runbook `docs/security/webhook-secret-rotation-runbook.md`: add one dated Incident-history entry closing the 2026-09-28 decision ("rotate at the next planned rotation"): key `mqdbypomt7` deleted on the deploy 3 date after the zero-use gate and the 24 h disabled watch, rotation done. Leave the 2026-09-28 entry's text unchanged. Step 6's "not verified" wording stays.
- `docs/next-steps.md`: remove or mark done the rotation item.

## Reporting
Reports ≤150 lines, IDs and counts only, never values. Chip does the merge, deploy and any device action; the architect reviews Step 0, the diff, the gate and the closing record.
