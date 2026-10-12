# WO-2026-10-06-001 — Deploy 3 status (delete old key a, Particle Cloud webhook)

From: Claude Code (claude-opus-5-5). To: architect. 2026-10-11. Step 0: `WO-2026-10-06-001-deploy3-step0.md` (accepted).

## Summary

- **Change:** `config/ingestion-consumers.json`, particle-cloud-webhook `apiKey` `{primarySlot: "a", rotation: {secondarySlot: "b", phase: "old-disabled"}}` → `{primarySlot: "b"}`. −4 net (budget −4); source code 0 lines.
- **Status:** deployed 2026-10-12 05:02:56 to 05:03:28 UTC by Chip; post-deploy checks passed (Dev-09's report not received, device-side). Observation gate passed. Close-out held for the architect.

## Build (local unless stated)

| Step | Result | Environment |
|---|---|---|
| Branch from main `2a32046`; fresh `npm ci`; suites | lambda 355/355, infra 65/65 (same as deploy 2) | local |
| cdk diff against live InfraStack | Exactly the expected set (below) | production (read-only) |
| Bundles against deployed zips | Only difference is registry content | local vs production assets |
| Mutation check (rule g) | Wrong edits caught (below) | local synth to a separate outdir |

**cdk diff (deploy 3):**
- [-] ApiKey slot a, logical ID ending `A4BA5483` (`mqdbypomt7`): destroy.
- [-] its UsagePlanKey (`…CloudWebhookApiKey0B37742576D39CBB`): destroy.
- [~] ingestion Lambda env: `INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK` Ref `…ApiKeyA4BA5483` → `…ApiKeyB7A7C38B4` (key b); `INGESTION_API_KEY_ROTATION_ID_PARTICLE_CLOUD_WEBHOOK` removed.
- [+] new Lambda Version `…1d934670` ([-] `…758836a9` orphaned, retained), prod alias moves; code assets ingestion `ff61a2e3…` → `60c08d3a…`, checker `102d36a9…` → `220f0e35…` (old hashes are deploy 2's).
- **Not in the diff:** key b, the serial key, plans fef2gk and t3oq8d, alarms, IAM. Template after: key b and the serial key (both enabled), each with its UsagePlanKey.

**Bundles.** For both functions, deployed vs new `index.js` differ only in the registry block (5 lines → `primarySlot: "b"`; ingestion :50056, checker :33988). In the source maps, `sources` and the other fields are identical; `sourcesContent` differs only in `config/ingestion-consumers.json`.

**Mutation check (rule g):**
- **M1, `primarySlot` left `"a"` with the rotation removed:** the synth would delete key b (the live key) and re-enable key a. Neither the state-independent tests nor the checker (one key, on the primary slot) would flag it. **Only this diff review catches it**, as `[-] …ApiKeyB… destroy`; the reviewed diff has no such line.
- **M2, `primarySlot` `"b"` with the rotation kept:** rejected at synth (`ingestion-consumers.ts:91-93`). The reviewed `cdk.out` template hash was unchanged afterwards.

## Security Gate

- **No plaintext secrets:** no key or secret value read, printed or written; no value flag; the function environment was not read. **No IAM change.**
- **Destructive operation:** deleting key a (`mqdbypomt7`) and its plan association. This is intended. Key a has been disabled since 2026-10-10 09:20 UTC, with 0 requests from then to 14:20 UTC on 2026-10-11. **Rollback:** after deletion, key a cannot be restored. Rollback is a new key via a fresh rotation. Key b stays the working key throughout.

## Deploy

- **Chip:** from `wt-rotation/infra`, using its reviewed `cdk.out`: `npx cdk deploy InfraStack --app cdk.out`. Deploy 2's applied `cdk.out` is kept as `cdk.out.deploy2-applied`. **Deadline:** before 2026-10-16T00:24Z (key b createdDate + 168 h), or the checker alerts overdue.

## Post-deploy checks (production, 2026-10-12)

| Check | Result |
|---|---|
| 1. Stack | `UPDATE_COMPLETE`, 05:02:56 to 05:03:28 UTC (32 s); post-deploy `cdk diff --app cdk.out`: "There were no differences" |
| 1. Deletes | UsagePlanKey 05:03:25.953, key a ApiKey 05:03:27.773 (`DELETE_COMPLETE`), both in the cleanup phase after the Lambda update; old Version `DELETE_SKIPPED` (retained); prod alias version 6 |
| 2. Key a | get-api-key for key a, no value flag: `NotFoundException` |
| 2. Key b, serial, plans | `mug6eyfk1l` and `2eisotew77` enabled; fef2gk lists only `mug6eyfk1l`, t3oq8d only `2eisotew77` |
| 3. Dev-14 report | 05:30:12.548, key b, 200; Lambda request `47a92ccb-2402-4b43-a008-537888235651`: `authResult: success`, consumer `particle-cloud-webhook`, boron-soak-1, Ubidots-Sensor-Hook-v1 |
| 3. Dev-09 report | not received by 05:52:57 UTC. No webhook or serial event from Dev-09 since 05:00:17 (last serial line), and no rejected request on any key, so it never reached AWS (device-side) |
| 3. Auth failures; serial key | 0 `ingestion_auth` failures; serial 7 requests, all 200 (05:03:28 to 05:49 UTC) |

- **Deploy window:** no request on any key between 05:02:56 and 05:03:28; not exercised live, as in deploys 1 and 2. **Check 3:** Dev-14's success shows `INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK` now resolves to key b (environment not read).

## Observation gate (production, 05:03:28 to the 09:00 UTC checker run; checked 12:15 UTC) — passed

- **Access log:** key b 12, serial 2eisotew77 216, all `POST /particle/log` 200. No 401 or 403 on any path. `ingestion_auth`: 12 key b and 216 serial, all `success`, 0 failures.
- **Checker 09:00:03 UTC:** `consumersChecked: 2, overdue: [], inconsistencies: [], failure: null, publishFailures: 0`. No SNS publish 08:55–09:15; Errors alarm OK.
- **Dev-09 (from AWS):** serial `SERIAL_MISSING` at 05:00:20 (after its 05:00:14 Ubidots report), absent until `SERIAL_CONNECTED` at 06:00:07. At 06:02:14–06:02:22 it disconnected and reconnected; the 06:03:06 line shows uptime 47 s (restart about 06:02:19). Then Ubidots 06:02:47 and status 06:02:51 on key b, `success` (Lambda requests `8eaf79f7-…`, `6b1a952a-…`), and hourly since. Last seen at 12:15 UTC: log line 12:13:32 (`[app] INFO: ChargeDiag: chg=DONE(3) …`), CONNECTED 12:15:26, MISSING 12:15:30, Ubidots on key b 12:13:18. **The trigger at about 05:30 fell while Dev-09 was off serial (05:00:20 to 06:00:07); its first report after the deploy arrived at 06:02:47.**
