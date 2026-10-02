**1. Per-finding verdicts**

Restored-source verification passed: **273/273 Lambda tests, 46/46 infra tests, and both TypeScript checks**.

Commands used installed Node 22 and local executables, without installation or network access:

```text
# From lambda/ and infra/:
node node_modules/jest/bin/jest.js --runInBand
node node_modules/typescript/bin/tsc --noEmit -p .

# Focused infra mutation runs:
node node_modules/jest/bin/jest.js --runInBand \
  --testPathPatterns=api-key-rotation.test.ts \
  --testNamePattern='daily rotation checker'
```

| Finding | Verdict | Reproduction and evidence |
|---|---|---|
| **F2** | **Partially closed** | Both original `console.warn` survivors now fail. Returned-event and SNS `MessageAttributes` leaks are caught. However, `console.dir`, `process.emitWarning`, Buffer writes, retained error causes, and logging hostile `Error` objects survive. See L01–L10 and L19–L25 below. |
| **F3a** | **Partially closed** | A no-op handler, empty consumer list, and wrong topic are caught. Checking only the first consumer and using a fixed 2031 clock both pass all 273 tests. Adding, removing, and reordering consumers in nonempty registry fixtures passes the two handler tests, but omitted healthy consumers remain unobservable. |
| **F3b** | **Partially closed** | `missingHandler` is caught. An unrelated entry file exporting `handler` passes all 46 infra tests. A substituted asset and Python runtime each pass all six checker infra tests. |
| **F3c** | **Partially closed** | `AmazonAPIGatewayAdministrator` and a separately constructed policy attached through `Ref` are caught. Attachment by explicit role name, an SNS resource policy, and a Lambda resource permission survive independently; their combined mutation passes all 46 infra tests. |
| **F5** | **Closed** | The original false-healthy result is no longer reproduced. Missing, invalid, and offset-less dates alert for either primary slot, with **zero detail reads**. Valid one-key states remain quiet. Tested zero-, two-, and three-key inconsistency paths also alert. Reverting the fix fails all three added tests. |
| **F6** | **Partially closed** | Upstream message text and existing cause chains are removed from list failures. However, synthetic values in permitted error-name/request-ID fields escape, including through the installed SDK with an offline transport. Detail and publish failures also relay arbitrary error names. |
| **F7** | **Closed** | The first-claimant-only mutation now fails specifically because the configuration log omits `beta`. Restored tests verify both registry orders and the unrelated consumer’s success. |

The changed `AccessDeniedException` fixture is **legitimate**: it preserves the failure assertion while moving the diagnostic identifier into `Error.name`. Suppressing unrestricted message text follows the credential-output contract. I found no other existing assertion or prescribed fixture narrowed, loosened, or re-encoded in the four-file diff.

**2. New findings, most severe first**

These are residual verification defects unless explicitly identified as unchanged-source behavior.

**R2-1 — should-fix — The permission assertion does not cover the checker’s complete permission surface.**

Location: [infra/test/api-key-rotation.test.ts:328](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-2/infra/test/api-key-rotation.test.ts:328).

The attachment search recognizes only serialized `{ Ref: roleId }`. Giving the checker an explicit role name and attaching `apigateway:*` through that literal name passes. The test also ignores resource policies: granting the checker `sns:*` on its topic or permission to invoke the ingestion Lambda passes.

Each mutation passed the six checker infra tests; all three together passed **46/46**. Consequently, these tests can certify permissions beyond the approved read/publish boundary. An imported-role substitution did fail, but through a setup-time `Fn::GetAtt` assumption rather than a permission assertion.

**R2-2 — should-fix — Output capture and serialization still conceal credential leaks.**

Locations: [lambda/src/tests/api-key-rotation-checker.test.ts:155](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-2/lambda/src/tests/api-key-rotation-checker.test.ts:155), also lines 171–194.

Three mutations emitted the synthetic sentinel into actual test-process output while **273/273 tests passed**:

- `console.dir(item)`;
- `process.emitWarning(JSON.stringify(item))`;
- `process.stdout.write(Buffer.from(JSON.stringify(item)))`.

The serializer introduces another independent gap. `JSON.stringify(Error)` omits its message and stack; Buffer serialization produces numeric bytes. After strengthening both detail-read and publish-error fixtures with sentinel-bearing messages, `console.error(error)` still passed every test. Changing those mutations to `console.error(String(error))` correctly failed.

Retaining the list error as `cause` also survived because the assertion examines only the outer message and stack. Hostile successful list/detail responses are exercised, but hostile failure coverage and output normalization remain incomplete.

**R2-3 — should-fix — An exported function does not establish the deployed checker’s identity or runtime compatibility.**

Location: [infra/test/api-key-rotation.test.ts:307](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-2/infra/test/api-key-rotation.test.ts:307).

Pointing the checker at `lambda/src/handler.ts`, the ingestion entry point, passed **46/46 infra tests**. Substituting the ingestion asset also passed the checker tests. Neither deployed function would perform the intended rotation check.

Overriding the synthesized runtime to `python3.12` likewise passed: the test loads the JavaScript using the local Node process without checking the configured runtime. These failures are distinct from the now-detected missing export.

**R2-4 — should-fix — The handler fixture cannot detect omitted consumers or an incorrect clock.**

Location: [lambda/src/tests/api-key-rotation-checker.test.ts:476](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-2/lambda/src/tests/api-key-rotation-checker.test.ts:476).

Only the first consumer produces events; every other consumer is healthy. Replacing the handler’s consumer list with `registeredConsumers().slice(0, 1)` therefore passes **273/273 tests**, despite silently omitting `serial-forwarder`.

Replacing the handler clock with `2031-01-01T00:00:00Z` also passes. The fixture’s keys are already overdue, and its assertions do not distinguish the resulting incorrect timing.

**R2-5 — note — The error sanitizer restricts characters, not sensitive content.**

Location: [lambda/src/api-key-rotation-checker.ts:105](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-2/lambda/src/api-key-rotation-checker.ts:105), also lines 185 and 255.

On unchanged source, a synthetic value consisting of allowed characters survives when supplied as the list error’s `name` or `$metadata.requestId`. Offline SDK responses carrying it in `x-amzn-errortype` or `x-amzn-requestid` reproduced the escape into the checker’s thrown message and stack.

Detail-read and publish failures interpolate `error.name` without even this character filter. Sentinel-bearing names escaped on both paths.

Normal upstream messages and cause chains were suppressed successfully. Malformed-page probes threw without exposing the sentinel. **I did not establish that live AWS places credentials in error names or request IDs.**

The repeated adjacent gaps warrant the Phase 3 review of these mechanisms called for by [docs/AI_DEVELOPMENT_WORKFLOW.md:144](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-2/docs/AI_DEVELOPMENT_WORKFLOW.md:144), before another narrow patch cycle.

**3. Mutations and results**

Every Lambda mutation ran against the entire **273-test suite**. Infra I01–I10 ran the **six checker tests**; I11–I12 ran the entire **46-test suite**.

| ID | Mutation | Result |
|---|---|---|
| L01–L02 | Warn with raw response; copy response into record and warn | Caught: two failures each |
| L03 | `console.dir(item)` | **Survived; sentinel emitted** |
| L04 | `console.table(item)` | Caught |
| L05 | `process.emitWarning` with response | **Survived; sentinel emitted** |
| L06 | Write response as stdout Buffer | **Survived; sentinel emitted** |
| L07 | Write response as stdout string | Caught |
| L08 | Preserve upstream list error as `cause` | **Survived** |
| L09–L10 | Log detail/publish error objects with existing fixtures | **Both survived** |
| L11 | Handler returns without checking | Caught |
| L12 | Handler checks only first consumer | **Survived** |
| L13–L14 | Handler uses empty consumers; wrong topic | Both caught |
| L15 | Handler uses fixed 2031 clock | **Survived** |
| L16 | Remove single-key creation-date check | Caught: three failures |
| L17 | Keep only first duplicate-key claimant | Caught: claimant-log assertion |
| L18 | Restore raw list-error propagation | Caught: two failures |
| L19 | Copy responses into returned events | Caught |
| L20 | Copy responses into SNS string `MessageAttributes` | Caught |
| L21 | Copy whole response into internal metadata only | **Survived; no output leak demonstrated** |
| L22–L23 | Log detail/publish `Error` objects after adding hostile messages to fixtures | **Both survived** |
| L24–L25 | Log those hostile errors as strings | Both caught |
| I01 | Configure `missingHandler` | Caught |
| I02 | Add API Gateway administrator managed policy | Caught |
| I03 | Use `ingestion.ts`, which lacks the configured export | Caught |
| I04 | Set synthesized runtime to Python | **Survived** |
| I05 | Attach broad policy by explicit role name | **Survived** |
| I06 | Grant checker `sns:*` through topic policy | **Survived** |
| I07 | Attach separate broad policy through role `Ref` | Caught |
| I08 | Substitute imported role | Test setup crashed; not a behavioral assertion |
| I09 | Grant checker ingestion-Lambda invocation through resource permission | **Survived** |
| I10 | Substitute ingestion Lambda’s code asset | **Survived** |
| I11 | Use unrelated `handler.ts` with a matching export | **Survived: 46/46** |
| I12 | Combine role-name policy, SNS policy, and Lambda permission | **Survived: 46/46** |

Totals: **37 mutations; 18 caught by assertions, 18 survived, one rejected during test setup**. A survivor is not automatically an output leak; L21 is explicitly distinguished above.

Additional temporary registry fixtures added a consumer, removed either existing consumer, and reversed their order: both handler tests passed for each. There were also **26 unchanged-source metadata/error probes**, including the offline SDK checks.

Evidence: [mutation results](/tmp/codex-round2-review/all-mutation-results.json), [probe results](/tmp/codex-round2-review/probe-results.json), [registry results](/tmp/codex-round2-review/registry-results.json).

**4. Effect on deferred findings**

- **F1:** Unchanged; round 2 does not alter ingestion deployment ordering or the code/environment transition behavior.
- **F4:** Unchanged; neither the runbook nor the deferred `"-"` attribution fixture was updated.

**5. Verification limits and cleanup**

- No live AWS behavior, IAM evaluation, SNS delivery, or Lambda runtime error serialization was verified. Infrastructure consequences follow from synthesized resources; SDK error propagation was tested with a local fake transport.
- The listed mutations establish concrete gaps, not exhaustive coverage of every possible output or deployment path.
- Final restored checks passed: **273 Lambda tests, 46 infra tests, both TypeScript checks**, and reverse-checking the supplied round-2 diff.
- No fixes were authored. All repository mutations and temporary test files were removed. No installation, network access, AWS calls, or real credential retrieval was performed.
- **The tree is clean:** working-tree and staged diffs are empty, and `git status --porcelain=v1 --untracked-files=all` returns no entries.