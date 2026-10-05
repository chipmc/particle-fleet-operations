**1. Verdicts**

| Area | Verdict |
|---|---|
| A. Authentication | **Verified with findings** |
| B. Checker IAM boundary | **Verified with findings** |
| C. CDK rotation lifecycle | **Defects found** |
| D. Mutation coverage | **Defects found** |

Restored-source verification passed: **267 Lambda tests, 44 infra tests, and both TypeScript checks**. I used the installed executables with Node 22; the initial launcher executions selected an older runtime.

Independently verified:

- Main and current synths contain **identical definitions for all six ingestion ApiKey/UsagePlan/UsagePlanKey resources**. Ingestion IAM roles, policies, and baseline environment also match.
- Forward/reverse overlap, disable, cleanup, and disable-to-overlap rollback preserve the intended key and association identities. Environment references follow the primary slot.
- `APIGATEWAY_USAGEPLANKEY_ORDERINSENSITIVE_ID` is enabled by CDK v2’s default. With it explicitly disabled, promotion changes the surviving association’s identity—the installed CDK documentation identifies the resulting duplicate-association replacement problem.
- Stable auth configurations preserve consumer isolation, the final pair check, and duplicate-secret detection. Additional probes covered inactive consumers, empty IDs, shared primary/secondary IDs, registry ordering, and IDs equal to environment-variable names. I found no validation disagreement across **208 API-key configuration shapes**.
- No rotation deploy guard, registrar, SSM anchor/intent parameter, or Lambda deadline was introduced.

**2. Findings, most severe first**

**F1 — blocking — Rotation deployments can temporarily reject valid credentials. Reproduced locally; AWS deployment consequence reasoned from the synthesized integration and installed CloudFormation documentation.**

Locations: `lambda/src/consumer-auth.ts:185–187`; `infra/lib/infra-stack.ts:718`, `:789–791`.

Two transitional configurations fail:

| Deployment transition | Temporarily active configuration | Result |
|---|---|---|
| Baseline → overlap | Old bundled registry declares no rotation; new environment supplies both IDs | Existing `alpha-a` plus alpha’s correct secret returns **503** |
| Disabled → cleanup | Old bundled registry declares rotation; new environment contains retained `alpha-b` as primary, without secondary | Retained `alpha-b` plus alpha’s correct secret returns **503** |

Beta remained 200 in both reproductions.

The synthesized API Gateway integration invokes the unqualified Lambda ARN; there are no versions or aliases. Installed CDK documentation at `infra/node_modules/aws-cdk-lib/aws-lambda/lib/lambda.generated.d.ts:1702` explicitly describes sequential configuration/code updates with possible invocations between them. Consequently, correct final templates do not establish gapless rotation.

Both added HTTP-level probes failed with **expected 200, received 503**. Evidence: [probe results](/tmp/codex-review-probes.log).

**F2 — should-fix — The credential-output tests miss actual console output. Reproduced.**

Locations: `lambda/src/tests/api-key-rotation-checker.test.ts:151–176`; `lambda/src/api-key-rotation-checker.ts:93–97`.

The harness inspects `console.info`, but not `console.warn`, `console.error`, or `console.log`.

- Adding `console.warn(item)` inside response conversion emitted the synthetic credential sentinel into captured Jest output while **all 267 Lambda tests passed**.
- Copying whole responses into metadata and then logging those records through `console.warn` also survived.
- Copying whole responses alone survived.
- Copying both responses and metadata into event summaries failed **three tests**, independently confirming that particular implementer claim.

The second whitelist protects current metadata-to-event output: summaries select ID/slot/enabled, other event fields are explicit, and the production handler discards the returned events. It is useful defence in depth. However, the survivor is also a **coverage gap**: plausible diagnostic logging bypasses the asserted output boundary without failing tests.

The source-import check is narrower than its claim. Its regex does not exclude additional dynamic/namespace imports or raw calls outside the injected reader. That limitation is **reasoned from inspection**, not an observed current value read.

**F3 — should-fix — Tests can certify a nonfunctional checker or materially broader role. Reproduced.**

Locations: `lambda/src/tests/api-key-rotation-checker.test.ts:169`; `infra/test/api-key-rotation.test.ts:265–279`; `infra/lib/infra-stack.ts:810`.

Three independent regressions survived:

- Making the exported checker handler return without running the check: **267/267 Lambda tests passed**.
- Configuring `handler: 'missingHandler'`: **44/44 infra tests passed**.
- Adding `AmazonAPIGatewayAdministrator` as a checker managed policy: **44/44 infra tests passed**.

The unit tests invoke `runRotationCheck`, not the production handler. The IAM assertion examines inline policies without constraining managed policies. These are verification defects; the restored implementation does not contain those mutations.

**F4 — should-fix — The required operational procedure and disabled-key attribution fixture are missing. Reproduced by repository inspection.**

Location: `docs/security/webhook-secret-rotation-runbook.md:88–105`, `:146–179`.

The runbook still describes two-ID support as unimplemented and not yet designed/approved. It does not specify the implemented slot/phase transitions or the required first-use verification of disabled-key access-log attribution.

For the required `403` record with `apiKeyId: "-"`, the procedure does not explicitly prohibit attributing it to the old key or require client-side correlation/rollback when attribution is uncertain. I found no corresponding two-case fixture covering `alpha-a` versus `"-"`.

The existing pre-disable zero-use gate remains documented. The missing instructions are additional contractual requirements.

**F5 — should-fix — A single key with missing creation metadata is silently reported healthy. Reproduced.**

Location: `lambda/src/api-key-rotation-checker.ts:152–155`.

Input: one primary alpha key, no declared rotation, and absent `createdDate`.

Outcome: **zero events**, because the one-key branch returns before checking dates. The brief’s approved rule requires missing dates to alert. The existing missing-date fixtures exercise only two-key states.

The added probe failed with **expected one inconsistency, received zero**. This does not challenge the approved normal one-key state; it concerns missing metadata.

**F6 — note — List failures bypass the checker’s output sanitization. Reproduced with synthetic input; actual credential-bearing AWS errors not established.**

Locations: `lambda/src/api-key-rotation-checker.ts:104`, `:217`, `:268`; checker test `:405`.

A `GetApiKeys` exception containing the synthetic credential sentinel escapes unchanged through `runRotationCheck`. An offline replay through the installed AWS SDK independently confirmed that service response messages become exception messages.

The existing list-failure test checks propagation, but does not apply the shared credential-output assertions. Unlike the caught detail/publish failures, this path can carry arbitrary upstream error text into Lambda error output. I did **not** establish that AWS normally returns credential values in these errors.

**F7 — note — The plural-claimant requirement lacks an effective regression assertion. Reproduced.**

Locations: `lambda/src/consumer-auth.ts:204`; `lambda/src/tests/consumer-auth-rotation.test.ts:164–174`.

Changing duplicate-key results to retain only the first `consumerId` left **all 267 Lambda tests passing**, while violating the approved requirement to identify every claimant. Current code correctly returns all claimants; my additional probe verified both registry orders.

**3. Mutations and results**

Every listed behavioral mutation was run against its component’s **entire existing suite**.

| Mutation | Result |
|---|---|
| Checker handler returns without checking | **Survived** |
| Copy entire SDK response into metadata | **Survived** |
| Copy response and spread metadata into summaries | Caught: 3 failures |
| Copy response and log metadata through `console.warn` | **Survived** |
| Log raw response through `console.warn` | **Survived; synthetic sentinel observed in output** |
| Set `includeValue: true` | Caught: 22 failures |
| Skip SNS publish | Caught: 23 failures |
| Suppress final failure throw | Caught: 2 failures |
| Change threshold comparison from `>=` to `>` | Caught: 10 failures |
| Read the wrong key’s details | Caught: 17 failures |
| Substitute list metadata for detail reads | Caught: 2 failures |
| Omit duplicate-key claimants after the first | **Survived** |
| Bypass final consumer equality check | Caught: 9 failures |
| Stop secret comparisons after first match | Caught: 4 failures |
| Add API Gateway administrator managed policy | **Survived** |
| Configure nonexistent checker handler | **Survived** |

**16 valid mutations: 9 caught, 7 survived.** An initial unconditional-return mutation produced a TypeScript narrowing error; I excluded that invalid attempt and reran a compiling equivalent.

Additional temporary probes produced four failures: the two deployment transitions, missing single-key creation metadata, and unsanitized list-error text.

The prescribed ±1 ms boundary, second-precision `+08:00` timestamp, exact alpha/alpha-long attribution, alpha/alpha-b collision, 0/1/2/3-key states, and disabled-key counting fixtures are present. Digest calls themselves are not instrumented; the auth fixture instruments `timingSafeEqual`.

The fake’s normal date, pagination, and detail-response shapes agree with an **offline installed-SDK replay**. Its pagination token encodes an offset internally, but current code passes it through unchanged and does not narrow the list between pages. No production defect from that mock simplification was reproduced.

**4. Is the checker role structurally incapable of acting on a key value?**

**No.**

From the synthesized grants and IAM semantics:

| Operation | Boundary |
|---|---|
| Read individual key values | **Allowed**, using `GetApiKey` with `includeValue: true` |
| Read key values through listing | **Allowed**, using `GetApiKeys` with `includeValues: true` |
| Limit reads to registered ingestion names | **Not enforced by IAM**; collection/item grants cover keys in the stack’s region |
| Create, modify, enable/disable, delete, or reassociate keys/plans/stages | **No grants** for the required mutation operations |
| Read through usage-plan keys, stages, or exports | **No grants** for those resource paths |
| Publish through SNS | Granted only to the rotation topic |
| Write a obtained value into logs or that topic | **Permitted by the available logging/publish grants** |

`AWSLambdaBasicExecutionRole` adds logging permissions, not API Gateway mutation permissions. The log-retention custom resource has a **separate role**; its retention permissions are not inherited by the checker.

Thus, API Gateway resource mutation is structurally unavailable under the synthesized grants. Value-free reading and output are **code properties**, not IAM guarantees.

**5. Unverified claims and cleanup**

- I did not reproduce the implementer’s complete original 21-mutation campaign; I ran the independent campaign above.
- Deployed associations, actual update timing, disabled-key 403 attribution, SNS confirmation/delivery, and live alarm behavior remain unverified under the no-AWS/no-network constraints.
- Installed SDK/CDK code supports the offline conclusions; this was not a live service or IAM-policy simulation.
- No fixes were authored. All production mutations and temporary repository test files were removed. Final tests/typechecks passed; `git status --porcelain`, working-tree diff, and staged diff were empty. Reverse-checking the supplied implementation diff also passed.
- `git checkout -- .` was denied because the sandbox makes `.git` read-only. Original file contents had already been restored by the mutation scripts; the subsequent clean-tree checks succeeded.