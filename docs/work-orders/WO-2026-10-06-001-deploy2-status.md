# WO-2026-10-06-001 — Deploy 2 status (disable old key a, Particle Cloud webhook)

From: Claude Code (claude-opus-5-5). To: architect. Opened 2026-10-10.

## Summary

- **Change:** `config/ingestion-consumers.json`, particle-cloud-webhook `rotation.phase` `"overlap"` → `"old-disabled"` (1 line changed, 0 net).
- **Effect:** API Gateway disables the primary slot's key, slot a (`mqdbypomt7`). Key b (`mug6eyfk1l`) stays enabled (`infra/lib/infra-stack.ts:819-820`).
- **Status:** deployed 2026-10-10 09:19:41 to 09:20:06 UTC, verified, and the 24-hour watch passed (below).

## Pre-deploy (local unless stated)

| Step | Result | Environment |
|---|---|---|
| Branch | `wo/2026-10-06-001-deploy2`, fresh from main `fd3f175` (#54 was squash-merged, so no rebase) | local |
| Fresh `npm ci`, suites with registry in `old-disabled` | lambda 355/355, infra 65/65 | local |
| cdk diff against live InfraStack | Exactly the expected set (below) | production (read-only) |
| Bundle comparison against deployed zips | Only difference is registry content | local vs production assets |

**cdk diff (deploy 2):**
- [~] Slot a key `mqdbypomt7` (logical ID ending `A4BA5483`): its Enabled property changes, true before the deploy and false in the template.
- [+] new Lambda Version (`…758836a9`); [-] old Version `…a757ea64` orphaned (retained); prod alias moves to the new one.
- [~] ParticleLogIngestionFunction code asset `a4bb4d59…` → `ff61a2e3…`.
- [~] IngestionApiKeyRotationCheckerFunction code asset `e7d21b66…` → `102d36a9…`.
- **Not in the diff:** key b (`…ApiKeyB7A7C38B4`, template `Enabled: true`), the serial key (`Enabled: true`), plans fef2gk and t3oq8d, all plan-keys. No IAM section, and no env-var change.

**Bundles.** For both functions, deployed vs new `index.js` differ in one line: `phase: "overlap"` → `phase: "old-disabled"` (ingestion line 50059, checker line 33991). In the source maps, `sources` and the other fields are identical; `sourcesContent` differs only in `config/ingestion-consumers.json`.

**Deploy (Chip):** from `wt-rotation/infra`, using its reviewed `cdk.out` (rule j): `npx cdk deploy InfraStack --app cdk.out`. Deploy 1's applied `cdk.out` is kept aside in the scratchpad as `cdk.out.deploy1-applied`.

## Notes carried from deploy 1 (for the architect)

- **Gate check timing:** the 24-hour zero-use gate on key a closed at 2026-10-10 02:40:37 UTC. The check that found 0 requests ran at 02:41:57 UTC, 80 seconds after it closed. The access-log query's end time was 02:41:57, so the gate period was fully covered. Only requests in the final seconds before the check could have been missed, if access-log delivery lagged.
- **Deploy window coverage:** the deploy window is unlikely to be exercised live. Deploy 1's update took 35 s (00:24:14–00:24:49 UTC), and the webhook key had no request inside it (gap 00:20:57 to 00:27:26). Webhook traffic is bursty around reporting times, so "200s throughout the deploy window" is evidence from either side of the window, not within it, unless a request happens to land inside.

## Deploy and post-deploy checks (production)

- **Deploy (Chip):** from the reviewed `cdk.out`, 2026-10-10 09:19:41 to 09:20:06 UTC (25 s), `UPDATE_COMPLETE`.
- **Post-deploy cdk diff** (`--app cdk.out`, same checkout): "There were no differences".
- **Keys (IDs and names only):**

| Key ID | Name | Enabled |
|---|---|---|
| `mqdbypomt7` | particle-ingestion-particle-cloud-webhook (slot a) | False |
| `mug6eyfk1l` | particle-ingestion-particle-cloud-webhook-b | True |
| `2eisotew77` | particle-ingestion-serial-forwarder | True |

- **Plan fef2gk:** still lists both webhook keys; plan-keys were not in the diff.
- **Prod alias:** version 5.
- **Before the deploy (09:00 to 09:18 UTC):** key b 4 requests, serial key 71, all 200.
- **After the deploy:** serial key 200s at 09:21:56 and 09:21:57. Key b 200s from two reports Chip triggered:
  - boron-soak-1 (Dev-14): 09:22:02.219, Lambda request `a8e1f695-983e-4d3a-b3b5-b8f4d22e0023`, Ubidots-Sensor-Hook-v1.
  - Dev-09: 09:22:03.257, Lambda request `6bdfb669-f862-41a4-b0f9-83998c9111c8`, Ubidots-Sensor-Hook-v1.
  - No key a request since the deploy (checked to 09:22:43 UTC).
- **Deploy window:** no request on any key inside 09:19:41 to 09:20:06. Not exercised live, as expected (see the notes above).

## 24-hour watch (production, 2026-10-10 09:20:06 to 2026-10-11 09:20:06 UTC; checked 2026-10-11 13:22 UTC)

| Access log | Requests | Status |
|---|---|---|
| Key a `mqdbypomt7` | 0 (also 0 from the deploy to 13:22 UTC Oct 11) | – |
| Key b `mug6eyfk1l` | 364 | all 200 |
| Serial key `2eisotew77` | 1,771 | all 200 |
| No key (`-`) | 13 | 403 |

- **The 13 no-key 403s:** all `GET /` or `GET /robots.txt` from 12 unrelated addresses (scanners). None is a `POST /particle/log`. The 24 h before deploy 2 had 4.
- **Key states:** `mqdbypomt7` False, `mug6eyfk1l` True, `2eisotew77` True.
- **Checker run, 2026-10-11 09:00 UTC:** `consumersChecked: 2, overdue: [], inconsistencies: [], failure: null, publishFailures: 0`. No SNS publishes on the rotation topic 08:55–09:15 UTC; the checker Errors alarm is OK.
- **Architect decision (2026-10-11):** no deliberate key a request, because it needs `get-api-key --include-value`. Whether a disabled-key 403 logs the old key ID or `-` is recorded in the runbook as **not verified**.
- **Runbook close-out** (`docs/security/webhook-secret-rotation-runbook.md`, +12/−5):
  - Step 2: the full expected deploy 1 diff.
  - Step 3: copy with `tr -d '\r\n'`.
  - Step 4: a bad paste never reaches AWS; check the first 200 on the new key ID plus the Particle integration log.
  - Step 6: the 403 logging is not verified.
- **Result:** the watch passed. PR #55 is ready for Chip to merge. Deploy 3 (delete key a) needs its own dispatch.
