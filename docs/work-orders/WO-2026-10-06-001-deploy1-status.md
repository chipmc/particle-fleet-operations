# WO-2026-10-06-001 — Deploy 1 status (key rotation overlap, Particle Cloud webhook)

From: Claude Code (claude-opus-5-5). To: architect. As of 2026-10-09 ~03:00 UTC.

## Summary

- **Deploy 1:** done and verified in production.
- **Cutover:** the Particle Cloud webhook now authenticates with key b (`mug6eyfk1l`).
- **Key a:** `mqdbypomt7` is still enabled on plan fef2gk, as the overlap phase intends.
- **PR #54:** open, not merged.
- **Still outstanding:** the 2026-10-09 09:00 UTC checker run, then Chip's merge of PR #54.

## Sequence

| Step | Result | Environment |
|---|---|---|
| Remove wt-regtests worktree; force-delete `wo/2026-10-08-001-registry-state-tests` | Done; its tree was identical to 685bd0d (#53) | local |
| Rebase onto 685bd0d | Fast-forward (`merge --ff-only`), because the branch had no commits; the +4 registry edit was kept uncommitted with no stash | local |
| Fresh `npm ci`, suites with registry in overlap | lambda 355/355, infra 65/65 | local |
| cdk diff against live InfraStack | Exactly the expected set (below) | production (read-only) |
| Bundle comparison against deployed zips | The only difference is the registry content | local vs production assets |
| Deploy (Chip, from wt-rotation/infra cdk.out) | 00:24:14 to 00:24:49 UTC, `UPDATE_COMPLETE` | production |
| Post-deploy checks | Pass (below) | production |
| Commit, push, PR | `0c7b0ae`, PR #54 (squash, not merged) | GitHub |
| Org secret `AWS_API_KEY` set to key b (Chip) | Cut over at 02:54:59 UTC after one fix (below) | Particle Cloud |

## cdk diff (deploy 1)

- [+] ApiGateway::ApiKey `particle-ingestion-particle-cloud-webhook-b`
- [+] ApiGateway::UsagePlanKey (key b on plan fef2gk)
- [~] ParticleLogIngestionFunction: code asset `97adee8b…` to `a4bb4d59…`; env adds `INGESTION_API_KEY_ROTATION_ID_PARTICLE_CLOUD_WEBHOOK`
- [+] new Lambda Version; [-] old Version orphaned (retained); prod alias moves to the new one
- [~] IngestionApiKeyRotationCheckerFunction: code asset `e18d5c12…` to `e7d21b66…`
- No IAM section. Nothing on key `mqdbypomt7`, plan fef2gk, or plan-key `mqdbypomt7:fef2gk`.

**Bundles.** For both functions, deployed vs new `index.js` differ only in the registry block (`rotation: {secondarySlot: "b", phase: "overlap"}`). In the source maps, `sources` and the other fields are identical; `sourcesContent` differs only in `config/ingestion-consumers.json`, and `mappings` shifts as a result.

## Post-deploy checks (production)

- **Stack:** `UPDATE_COMPLETE` at 2026-10-09 00:24:49 UTC.
- **Plan fef2gk:** both keys are enabled (IDs and names only):
  - `mqdbypomt7` particle-ingestion-particle-cloud-webhook, created 2026-09-21T07:34:04Z
  - `mug6eyfk1l` particle-ingestion-particle-cloud-webhook-b, created 2026-10-09T00:24:19Z
- **Access logs, 00:14 to 01:36 UTC:** only 200s. `mqdbypomt7` 52, serial forwarder `2eisotew77` 216.
- **Caveat:** `mqdbypomt7` had no traffic in the deploy window itself (gap 00:20:57 to 00:27:26). The requests on either side of the window succeeded.

## Cutover (step 4)

- **First paste:** the value Chip pasted carried a trailing CR. Particle rejected the webhook before sending: `Invalid character in header content ["x-api-key"]`.
- **Effect:** no webhook traffic reached AWS from 02:40:37 UTC (the last `mqdbypomt7` request) to 02:54:59 UTC. Reports in that window were lost on the Particle side; the serial forwarder was unaffected.
- **Fix:** Chip re-pasted without the CR. The first `mug6eyfk1l` request came at 02:54:59 UTC with status 200, and Chip confirmed from the Particle side that it is working.
- **Key values:** no key value was read by Claude Code; `get-api-key --include-value` was never run by Claude Code.

## Checker runs

- **2026-10-08 09:00 UTC** (before deploy 1): `consumersChecked: 2, overdue: [], inconsistencies: [], failure: null, publishFailures: 0`. No SNS publishes on either topic between 08:55 and 09:15 UTC.
- **2026-10-09 09:00 UTC:** pending. This is the first run with the registry in overlap.

## Commit contents (`0c7b0ae`, PR #54)

- `config/ingestion-consumers.json`: +4 net, the rotation block.
- `docs/next-steps.md`: one line queueing a repo-hygiene WO (untrack `lambda/dist`, ignore stray compiled files under `lambda/src`).
- `.secrets.baseline`: the existing entry for the registry moves from line 20 to 24. This was forced by the detect-secrets hook; there are no new findings.
- **Stray push:** the first commit attempt failed on that hook, and the push that followed created the remote branch at 685bd0d (identical to main) before `0c7b0ae` was pushed.

## For the architect

1. **Lesson for step 4 in future rotations:** have the operator copy the value with whitespace stripped (`… --query value --output text | tr -d '\r\n\t ' | pbcopy`), and confirm the first request on the new key ID within one reporting interval.
2. **Merge:** Chip merges PR #54 after the 2026-10-09 09:00 UTC checker run and the live checks.
3. **Retiring key a** (`mqdbypomt7`, ending the overlap) is the next phase and needs its own dispatch.
