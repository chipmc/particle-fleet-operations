**1. Verdicts**

| Group | Verdict |
|---|---|
| R3-1 — claims 1–3 | **Verified with findings** |
| R3-2 — claims 4–8 | **Defects found** |
| Round-3 fixes — claims 9–13 | **Defects found** |
| Mutations — claim 14 | **Defects found** |

The unmodified adapter satisfies the inspected ID-free runtime boundary. The findings below concern required regression enforcement and drill coverage; I reproduced no credential leak in the unmodified implementation.

Verified evidence:

- Restored suites pass **329/329 Lambda**, **79/79 infra**, and **43/43 isolated foundation**. Both restored TypeScript checks pass.
- Independently synthesizing the supplied main export reproduces the recorded fixture, after sorting unordered `DependsOn` entries. CDK CLI path metadata is necessary to reproduce its deployment hash.
- Against `dea4057`, foundation synthesis adds exactly **eight guards** and changes only `DependsOn` on **nine resources**. The REST deployment logical ID remains unchanged; no dependency cycle exists.
- Guards have the required function, principal, account, API, stage, method/path, and retention settings. Their paths come from defined routes.
- The prescribed timing, offset, daily-run, key-count, disabled-key, duplicate-name, and consumer-attribution fixtures remain present.
- Date branding, handler-clock assertions, single-attempt SNS publication, and direct `Fn::Sub` reference detection withstand relevant mutations.

**2. Findings, most severe first**

**R4-1 — should-fix — The bare-function regression scan still permits an invocable trigger. Reproduced; high confidence.**

Location: [infra/test/lambda-alias.test.ts:73](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-4/infra/test/lambda-alias.test.ts:73).

I added an enabled scheduled rule and its Lambda permission. Both constructed the unqualified function ARN by splitting the existing alias ARN and joining its first seven components, removing `:prod`.

The synthesized target and permission resolve to the bare function, but reference only the alias logical ID. The direct-function-reference scan misses both:

- Mechanism: **79/79 passed**.
- Isolated foundation: **43/43 passed**.

This violates Revision 6’s required test that any bare-function trigger or additional permission must fail. Direct `Fn::Sub`, variable-map, and `Fn::Join` references are detected; derived target equivalence remains unchecked.

Evidence: [synthesized target resolution](/tmp/codex-round4-review/I13-target-resolution.json), [mechanism results](/tmp/codex-round4-review/I13-split-alias-direct-trigger.log), [foundation results](/tmp/codex-round4-review/F02-foundation-derived-bare-trigger.log).

**R4-2 — should-fix — Side-effect imports bypass the module allowlist. Reproduced; high confidence.**

Location: [lambda/src/tests/rotation-checker/architecture.test.ts:24](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-4/lambda/src/tests/rotation-checker/architecture.test.ts:24).

The import parser recognizes `from`, dynamic imports, and `require`, but misses ordinary side-effect imports.

I temporarily added `import '../review-output-probe'` to the core. That module performed a filesystem write when loaded. The write occurred, yet **329/329 Lambda tests passed**.

The same parser enforces the adapter’s import restrictions. Thus R3-7’s allowlist does not fully enforce the approved module boundary. Direct filesystem imports are caught; this standard import form is not.

Evidence: [full-suite result](/tmp/codex-round4-review/L19-side-effect-output.log), [observed write](/tmp/codex-round4-review/side-effect-executed.txt).

**R4-3 — should-fix — Compile-time fixtures do not reject `id` and raw `name` on every required boundary. Reproduced; high confidence.**

Location: [lambda/src/tests/rotation-checker/boundary-types.test.ts:46](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-4/lambda/src/tests/rotation-checker/boundary-types.test.ts:46).

Six independent widenings survived **81/81 checker tests**: adding optional `id` or `name` to each of:

- `RotationRunSummary`;
- the checker-failure `RotationEvent` variant;
- the adapter’s failure-result variant.

Adding both fields to the summary also passed **329/329 Lambda tests**. The architecture scan likewise misses these plain field names outside the adapter.

Positive controls worked: widening observed slots, malformed slots, or key summaries failed with **TS2578** for both fields.

This deviates from Revision 6’s explicit requirement for negative fixtures on every boundary/output type. The current runtime projection remains ID-free, but these boundary regressions can pass its claimed gates.

Evidence: [mutation results](/tmp/codex-round4-review/lambda-mutation-results.json), [full-suite summary widening](/tmp/codex-round4-review/T07-summary-both-full-suite.log).

**R4-4 — should-fix — The drill does not exercise the approved cleanup procedure. Document inspection; consequences reasoned, not AWS-reproduced.**

Location: [foundation-rollback-drill.md:44](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-4/docs/operations/wo-2026-09-30-001-foundation-rollback-drill.md:44).

Step 4 attempts re-foundation, conditionally handles statement-ID conflicts, and calls that exercise proof for eventual cleanup. Step 5 then deletes the stack.

It never exercises Revision 6’s separate cleanup sequence: verify alias routing, remove guard resources while retaining statements, verify integrations remain unchanged, delete only recorded statements, and smoke-test every route. Smoke-loop requirements and result counters explicitly cover steps 2–3, not reconciliation and cleanup.

It also attempts re-foundation before reconciling retained statements, whereas the approved design requires reconciliation first. The drill needs separate evidence for re-foundation and guard retirement, including the successful recreation path and resulting statement inventory.

The prescribed `GetPolicy` command does **not** print credential values.

**Note — API Gateway read retries.**

At `lambda/src/rotation-checker/metadata-adapter.ts:94`, SDK defaults remain enabled. An independent HTTP-500 probe produced **three reads**, followed by the fixed failure result. SNS publication is single-attempt.

I agree with interpreting “no retries” as prohibiting alert-publication retries here: idempotent metadata reads do not themselves duplicate alerts. That distinction should be explicit in the design; its current wording remains ambiguous.

The reference-scan and import-boundary survivors repeat mechanisms identified in round 3. The workflow’s Phase 3 escalation rule applies before another narrow patch to those enforcement mechanisms.

**3. Mutations run and results**

**48 mutation runs: 38 caught, 10 survived.**

| Mutations | Result |
|---|---|
| L01–L03: skip handler, omit consumers, fixed 2020 clock | All caught |
| L04–L08: SNS retries, unsafe Date branding, ID read, raw-name output, response-derived label | All caught |
| L09–L14: discard disabled keys, weaken duplicate detection, strict threshold, stop pagination, request values, hide read failure | All caught |
| L15–L18: wrong topic, skip publication, suppress final throw, direct filesystem import | All caught |
| T01/T02/T06: add `id` or `name` to observed slots, malformed slots, key summaries | Six caught by TS2578 |
| T03–T05: add either field to summary, failure event, adapter failure | **Six survived** |
| L19: output through side-effect import | **Survived, 329/329** |
| T07: add both fields to summary | **Survived, 329/329** |
| I01–I08: missing guard; wrong retention, account, method, stage, path, or function | All caught |
| I09–I11: remove HTTP-integration, default-stage, or REST-deployment guard dependencies | All caught |
| I12/I14: variable-map `Fn::Sub` bare trigger or checker-role grant | Both caught |
| I13: derive bare trigger/permission ARN from alias ARN | **Survived, 79/79** |
| F01: remove foundation matcher’s `Fn::Sub` support | Caught |
| F02: derived bare trigger/permission on foundation | **Survived, 43/43** |

Caught cases failed relevant assertions or the intended TS2578 checks. Additional probes covered a proxied Date, reference-expression forms, retry counting, independent fixture regeneration, dependency graphs, and foundation template comparison.

Evidence: [complete mutation results](/tmp/codex-round4-review/all-mutation-results.json).

**4. Verification limits and cleanup**

- Native Node 22 execution encountered sandbox loopback restrictions: **317/329 Lambda** and **78/79 infra** passed. Using the same transport-only in-process preload as round 3, restored suites passed completely. SDK serialization/deserialization remained exercised; TCP behavior did not.
- The rollback model faithfully represents the stated retain/removal ordering, including the REST stage hazard and HTTP auto-deploy path. It cannot prove live policy retention, generated statement IDs, collisions, or propagation.
- `{deviceId}` paths match main’s existing CDK permissions. Actual service-side ARN matching remains a live-drill check.
- An illustrative policy-size calculation for eight guards plus nine historical permissions was approximately **9.3 KB**. Actual policy size and accumulation across re-foundation cycles require `GetPolicy`.
- Opaque imported values, deployed IAM, live route responses, and AWS delivery behavior remain unverified.

No network, AWS calls, dependency installation, real credential retrieval, or fixes were performed. All mutations were restored. Final tests and both type-checks pass; working-tree and staged diffs are empty. **`git status --porcelain=v1 --untracked-files=all` is empty. The tree is clean.**