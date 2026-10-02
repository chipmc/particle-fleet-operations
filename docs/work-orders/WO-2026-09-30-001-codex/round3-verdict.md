**1. Verdicts**

| Claim group | Verdict |
|---|---|
| Revision 4 — claims 1–6 | **Verified with findings** |
| Revision 5 — claims 7–13 | **Defects found** |
| Mutations — claim 14 | **Defects found** |
| Process — claim 15 | **Verified** |

Forward foundation deployment checks passed. Historical main `917a304` and foundation `9789f04`, synthesized at the same filesystem path with the same installed dependencies, produce a **byte-identical shared function resource**. The foundation adds one retained version, one `prod` alias, and two API-wide permissions; changes all eight production integrations; and rolls the REST deployment/stage without a dependency cycle. Nine generated permissions change, including REST’s additional test-invoke permission.

The stage-independent permissions address the forward deployment dependency problem. They authorize the qualified alias before HTTP integrations or the REST deployment switch. Subsequent replacement and cleanup of per-route permissions leave these independent alias grants available. Their wildcards broaden access within each specified API, but remain scoped to that API and qualified alias; I do **not** consider that a deviation from the approved wording.

Code/configuration version tests passed. Independently changing the actual bundled registry produced distinct versions for steady, overlap, old-disabled, and cleanup states. The deployment model exercises both update orders, coherent adjacent versions, and mixed-`$LATEST` 503 controls. It agrees with the semantics supplied in the design, while remaining an offline model. The legacy HTTP ingestion route is absent; the seven remaining HTTP routes are GET query/fleet routes, consistent with the recorded PR #39 retirement.

The production-handler fixture now detects omitted consumers. The synthesized-asset test detects an ingestion entry point, an actual ingestion-asset substitution, and Python runtime. F5 and F7 remain closed in the tested paths. Boundary-type widening produces **TS2578**, as intended.

Local original Git history confirms the dedicated foundation branch at `9789f04`, parent `917a304`, and mechanism ancestry through `64fce8d` to `c993bbb`. The supplied foundation diff matches that history exactly. The foundation synthesizes independently of the mechanism.

**2. Findings, most severe first**

**R3-1 — blocking — The second value-safety guarantee is not established for `id`. Reproduced.**

Location: [metadata-adapter.ts:71](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/lambda/src/rotation-checker/metadata-adapter.ts:71).

A successful response containing a synthetic credential-shaped alphanumeric string in `id`, an expected registry slot name, and otherwise valid metadata passes projection. The production handler then publishes that string in `keys[].id`.

I reproduced this through the installed SDK and production composition, with the same synthetic string also present in `value`. Dropping `value` does not prevent the copy in `id` from crossing the boundary.

**Design-contract mismatch:** the four-field projection follows the proposed mechanism, but character validation does not establish the design’s broader guarantee that no returned or echoed credential can cross it. This needs design-level disposition before that guarantee can be declared verified. I did **not** establish that live AWS puts credentials in `id`.

Evidence: [unchanged-source probes](/tmp/codex-round3-review/probe-results.log).

**R3-2 — should-fix — Reverting a completed foundation deployment permits an invocation-permission gap. Reasoned from synthesized templates; not reproduced on AWS.**

Location: [infra-stack.ts:753](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/infra/lib/infra-stack.ts:753).

After successful foundation completion and cleanup, no API Gateway permission authorizes the unqualified function. A subsequent update reverting to main restores the unqualified REST integration. Its replacement production permission references the REST stage, while that stage switches through the restored deployment.

The graph therefore permits the stage to serve the unqualified integration before its permission is recreated. Existing alias permissions cannot authorize that invocation, creating a potential 500 window.

This concerns reverting an already completed foundation deployment. Automatic rollback before cleanup may still retain the original permissions. **The documented foundation rollback has not established the design’s no-outage property.**

Evidence: [reverse-update permission dependencies](/tmp/codex-round3-review/foundation-revert-order.json).

**R3-3 — should-fix — Date projection evaluates an unapproved getter. Reproduced.**

Location: [metadata-adapter.ts:42](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/lambda/src/rotation-checker/metadata-adapter.ts:42).

A valid Date carrying a `Symbol.toStringTag` getter causes `Object.prototype.toString.call(raw)` to execute that getter. My probe observed one invocation and a successful metadata result.

This violates the required “unapproved getters never evaluated” boundary. Such a getter can execute side effects before projection finishes. The existing decorated-Date fixture does not exercise it. This is an object-level finding; ordinary JSON responses cannot directly encode this getter.

Evidence: [unchanged-source probes](/tmp/codex-round3-review/probe-results.log).

**R3-4 — should-fix — Quoted-ID searches miss valid `Fn::Sub` references in both permission and trigger checks. Reproduced.**

Locations: [api-key-rotation.test.ts:359](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/infra/test/api-key-rotation.test.ts:359), [lambda-alias.test.ts:65](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/infra/test/lambda-alias.test.ts:65).

Two valid mutations survived:

- **I07:** SNS policy granting `sns:*` to `{"Fn::Sub":"${CheckerRoleLogicalId.Arn}"}` — **7/7 checker tests passed**.
- **I13:** Enabled scheduled invocation of the unqualified ingestion function, with its invoke permission, both using `Fn::Sub` — **63/63 infra tests passed**.

Neither token contains the quoted standalone logical ID sought by the searches. Thus, the required whole-template permission and direct-invocation regression checks remain incomplete. The unmodified template has the intended grants and alias targets.

**R3-5 — should-fix — A clock that suppresses overdue alerts still passes every Lambda test. Reproduced.**

Location: [handler.test.ts:72](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/lambda/src/tests/rotation-checker/handler.test.ts:72).

Replacing the handler clock with fixed `2020-01-01T00:00:00Z` passed **318/318 tests**. The fixture expects non-overdue inconsistencies and does not assert `checkedAt`, so an excessively early clock preserves its expected output.

In production, this mutation suppresses overdue events for subsequently created keys. The specific 2031 survivor is caught now, but the wrong-clock category remains open. Consumer omission is separately closed.

**R3-6 — should-fix — SDK publishing retries contradict the design’s “no retries” wording. Reproduced.**

Locations: [emitters.ts:60](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/lambda/src/rotation-checker/emitters.ts:60), [handler.test.ts:111](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/lambda/src/tests/rotation-checker/handler.test.ts:111).

With SNS returning HTTP 500, two consumer events generated **six Publish requests: three per consumer**. `SNSClient({})` retains SDK retries. Disabling Lambda asynchronous retries does not disable these attempts.

The failure fixture compares consumer IDs through a `Set`, concealing repeated attempts. **This deviates from the approved no-retries wording.** Repeated attempts are reproduced; duplicate delivery after an ambiguous failure remains a reasoned consequence.

Evidence: [retry results](/tmp/codex-round3-review/retry-probe-results.json).

**R3-7 — note — The architecture test does not enforce the core’s no-output rule. Reproduced.**

Location: [architecture.test.ts:51](/private/tmp/claude-501/-Users-chipmc-Documents-Maker-AWS-particle-fleet-operations/80820a3e-1e11-48c6-a2be-a48f4ce90c6d/scratchpad/codex-review-3/lambda/src/tests/rotation-checker/architecture.test.ts:51).

Adding a filesystem import and `appendFileSync` of core input records passed **318/318 tests**. The check rejects SDK imports, `console`, and `process`, but permits this output dependency.

Other architecture mutations failed correctly. This survivor demonstrates incomplete enforcement of a required module rule; it did not independently demonstrate a credential leak.

**3. Mutations run and results**

**38 valid mutations: 34 caught, four survived.** L01–L24 ran the complete Lambda suite. L25 ran the compile-time boundary suite. Infra checker mutations used seven checker tests; alias mutations used fourteen alias tests. Valid asset substitution and I13 ran the full infra suite.

| IDs | Mutation | Result |
|---|---|---|
| L01–L02 | Skip handler work; evaluate only first consumer | Both caught |
| L03 | Fixed 2031 clock | Caught |
| L04 | Fixed 2020 clock | **Survived: 318/318** |
| L05–L06 | Request values; publish to wrong topic | Both caught |
| L07–L09 | Skip publishing; suppress final throw; turn read failure into success | All caught |
| L10–L12 | Change `>=` to `>`; ignore malformed metadata; omit duplicate-key claimants | All caught |
| L13–L14 | Spread raw item into metadata; drop disabled keys | Both caught |
| L15–L17 | Output raw response; import SDK outside adapter; export SDK client | All caught |
| L18 | Add filesystem output to core | **Survived: 318/318** |
| L19 | Retain decorated upstream Date | Caught |
| L20–L23 | Accept `value`, summary `Error`, emitter string, or failure `Error` | All caught by **TS2578** |
| L24 | Stop pagination early | Caught |
| L25 | Accept raw SDK `ApiKey` as publisher input | Caught by **TS2578** |
| I01 | Substitute ingestion entry point | Caught |
| I02-valid | Substitute actual ingestion code asset | Caught |
| I03 | Configure Python runtime | Caught |
| I04–I06 | Literal-role-name policy; SNS resource policy; Lambda resource permission | All caught |
| I07 | SNS policy principal through `Fn::Sub` | **Survived: 7/7** |
| I08–I10 | Wrong API-wide permission ARN; remove HTTP or REST permission dependency | All caught |
| I11–I12 | Destroy published versions; pin alias to version 1 | Both caught |
| I13 | Unqualified scheduled invocation through `Fn::Sub` | **Survived: 63/63** |

One initial asset-substitution attempt was invalid: it added lowercase fields beside the existing CloudFormation `Code` fields. I excluded it and reran a valid substitution.

Additional temporary work comprised boundary probes, an independent SDK request-handler replay, retry counting, historical synthesis comparisons, and registry-phase synthesis. All source mutations and temporary repository tests were restored or removed.

Evidence: [complete mutation results](/tmp/codex-round3-review/all-mutation-results.json).

**4. Verification limits and cleanup**

- Native test execution encountered sandbox `listen EPERM` failures: **307/318 Lambda** and **62/63 infra** passed; the remaining tests required loopback listeners.
- Using an external, transport-only in-process HTTP preload, the **restored suites passed 318/318 and 63/63**. Both restored TypeScript checks passed with **Node 22.23.1**. Production SDK serialization, deserialization, composition, and bundled-export execution remained exercised; TCP behavior was not.
- Independent SDK replay confirmed wire `item` → `items`, epoch seconds → Date, the four required metadata fields, opaque positions, and `includeValues=false`. This verifies SDK parsing, not what the live service sends. The installed client defaults to `NoOpLogger`; no additional SDK-output leak was reproduced.
- Historical synthesis reused installed dependencies. Main’s exact locked dependency tree was not recreated: installed versions of `@smithy/core`, `@smithy/types`, and `@aws-sdk/types` differ from that lockfile.
- AWS propagation, live permission replacement/cleanup, deployed IAM, actual Lambda timeout/unhandled-rejection behavior, SNS delivery, and route smoke tests remain unverified. No network, AWS calls, installation, or real credential retrieval occurred.
- No fixes were authored. Working-tree and staged diffs are empty; both supplied implementation diffs reverse-check successfully. **`git status --porcelain=v1 --untracked-files=all` is empty. The tree is clean.**