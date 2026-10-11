# WO-2026-10-06-001 — Deploy 3 status (delete old key a, Particle Cloud webhook)

From: Claude Code (claude-opus-5-5). To: architect. 2026-10-11. Step 0: `WO-2026-10-06-001-deploy3-step0.md` (accepted).

## Summary

- **Change:** `config/ingestion-consumers.json`, particle-cloud-webhook `apiKey` `{primarySlot: "a", rotation: {secondarySlot: "b", phase: "old-disabled"}}` → `{primarySlot: "b"}`. −4 net (budget −4); source code 0 lines.
- **Status:** Stage 8 OK from the architect (2026-10-11). Waiting for Chip's deploy.

## Build (local unless stated)

| Step | Result | Environment |
|---|---|---|
| Branch | `wo/2026-10-06-001-deploy3` from main `2a32046` | local |
| Fresh `npm ci`, suites | lambda 355/355, infra 65/65 (same as deploy 2) | local |
| cdk diff against live InfraStack | Exactly the expected set (below) | production (read-only) |
| Bundles against deployed zips | Only difference is registry content | local vs production assets |
| Mutation check (rule g) | Wrong edits caught (below) | local synth to a separate outdir |

**cdk diff (deploy 3):**
- [-] ApiKey slot a, logical ID ending `A4BA5483` (`mqdbypomt7`): destroy.
- [-] its UsagePlanKey (`…CloudWebhookApiKey0B37742576D39CBB`): destroy.
- [~] ingestion Lambda env: `INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK` Ref `…ApiKeyA4BA5483` → `…ApiKeyB7A7C38B4` (key b); `INGESTION_API_KEY_ROTATION_ID_PARTICLE_CLOUD_WEBHOOK` removed.
- [+] new Lambda Version `…1d934670`; [-] `…758836a9` orphaned (retained); prod alias moves.
- [~] code assets: ingestion `ff61a2e3…` → `60c08d3a…`; checker `102d36a9…` → `220f0e35…`. Both old hashes are deploy 2's.
- **Not in the diff:** key b, the serial key, plans fef2gk and t3oq8d, alarms, IAM.
- **Template after:** ApiKeys are key b (enabled) and the serial key (enabled), each with its own UsagePlanKey.

**Bundles.** For both functions, deployed vs new `index.js` differ only in the registry block (5 lines → `primarySlot: "b"`; ingestion :50056, checker :33988). In the source maps, `sources` and the other fields are identical; `sourcesContent` differs only in `config/ingestion-consumers.json`.

**Mutation check (rule g):**
- **M1, `primarySlot` left `"a"` with the rotation removed:** the synth would delete key b (the live key) and re-enable key a. Neither the state-independent tests nor the checker (one key, on the primary slot) would flag it. **Only this diff review catches it**, as `[-] …ApiKeyB… destroy`; the reviewed diff has no such line.
- **M2, `primarySlot` `"b"` with the rotation kept:** rejected at synth (`ingestion-consumers.ts:91-93`).
- The reviewed `cdk.out` template hash was unchanged afterwards.

## Security Gate

- **No plaintext secrets:** no key or secret value read, printed or written. No `--include-value`; the function environment was not read. Key IDs only.
- **No IAM change:** none in the diff.
- **Destructive operation:** deleting key a (`mqdbypomt7`) and its plan association. This is intended. Key a has been disabled since 2026-10-10 09:20 UTC, with 0 requests from then to 14:20 UTC on 2026-10-11.
- **Rollback:** after deletion, key a cannot be restored. Rollback is a new key via a fresh rotation. Key b stays the working key throughout.

## Deploy

- **Chip:** from `wt-rotation/infra`, using its reviewed `cdk.out`: `npx cdk deploy InfraStack --app cdk.out`.
- **Kept aside:** deploy 2's applied `cdk.out` is in the scratchpad as `cdk.out.deploy2-applied`.
- **Deadline:** before 2026-10-16T00:24Z (key b createdDate + 168 h), or the checker alerts overdue.

## Post-deploy and observation gate (production) — pending
