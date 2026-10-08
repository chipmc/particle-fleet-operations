<!-- Codex gpt-6-astra, reasoning high, run 2026-10-08 on a disposable snapshot of the uncommitted +42/-23 test diff (patch identical to the WO branch working tree). Evidence paths below are Codex's local scratch files and are not kept. -->

VERDICT: PROBLEM

Verification is incomplete: the sandbox rejects local server binding with `listen EPERM: operation not permitted 127.0.0.1`. No vacuous rewritten assertion was demonstrated, but I cannot certify the endpoint-dependent assertions.

## 1. Each rewritten test

| Test | Behavior protected | Mutation result |
|---|---|---|
| 1 | Steady slot-a resources retain recorded logical IDs. | Changed slot-a construct IDs. **Caught:** hard-coded ID comparison failed at line 106. |
| 2 | Both infra and Lambda accept the checked-in registry. | Removed `a` from Lambda’s allowed slots. **Caught:** expected `[undefined, undefined]`, received two `invalid_primary_slot` results at line 466. |
| 3 | Configured deployed export runs and reports `no_keys` for every consumer. | Renamed the production handler export. **Caught:** expected `"function"`, received `"undefined"` at line 332. **The rewritten per-consumer assertion remains unverified:** normal execution stops at socket setup. |
| 4 | Synthesized key names, multiplicity, and enabled flags match declared slots. | Added a third key and separately left old-disabled primaries enabled. **Both caught** by equality assertion at line 256. |
| 5 | Every consumer produces the expected events and summary, using the configured topic and real clock. | Made production `registeredConsumers()` skip the last consumer. **Blocked:** `beforeEach` failed before the handler ran. |
| 6 | Publication failure still attempts every expected event exactly once and reports failures. | Same skipped-consumer mutation. **Blocked:** `beforeEach` failed before the handler ran. |

Tests 1, 2, and 4 demonstrated meaningful mutation detection. Test 3 demonstrated bundle-export detection, but that does not establish its rewritten `no_keys` assertion.

## 2. Consumer coverage and mock isolation

**(a) Skipped consumer:** not dynamically confirmed for tests 5–6. Both selected tests failed on `EPERM` and hook timeouts; those failures cannot count as detecting the mutation.

**(b) Real bundle and registry:** confirmed through synthesis and inspection:

- The synthesized function specifies `nodejs22.x` and `index.handler`.
- Its actual asset exports a function.
- The bundled registry source matches the checked-in file byte-for-byte.
- The asset contains no test sources or `jest.mock`.
- Infra and Lambda suites ran in separate Jest processes; infra’s configured test root excludes the Lambda test file.

See [bundle inspection results](/private/tmp/wo-001-review-3i0mmm32/bundle-facts.json). The infra test loads that synthesized asset; invoking its handler remained blocked by socket setup.

## 3. Test 4’s expectation

**No**, its expectation does not come from the template or imported implementation helpers. Lines 247–252 read the registry JSON and independently express slot naming and enabled-state rules. Lines 254–256 extract and compare the actual template resources.

Both requested mutations produced assertion failures:

- **Third key:** received an additional `mutation-third-key` entry.
- **Old-disabled primary enabled:** expected `Enabled: false`, received `true` for both primary keys.

## 4. Four-state suite runs

Both consumers were placed in each state. These are complete-suite counts:

| Registry state | Infra passed / failed | Lambda passed / failed |
|---|---:|---:|
| Steady `a` | 64 / 1 | 343 / 12 |
| Overlap `a → b` | 64 / 1 | 343 / 12 |
| Old-disabled `a → b` | 64 / 1 | 343 / 12 |
| Steady `b` | 64 / 1 | 343 / 12 |

Every failed test contained `EPERM`. Each state had **2/3 infra suites** and **22/25 Lambda suites** passing, with no skipped tests.

Runs used installed Node **22.23.1**, invoking:

```text
node node_modules/jest/bin/jest.js --runInBand --no-cache --json --outputFile=…
```

[Exact commands and matrix results](/private/tmp/wo-001-review-3i0mmm32/matrix-summary.log).

## Mutations and restoration

Executed the temporary [review runner](/private/tmp/wo-001-review-3i0mmm32/run_review.py) with `matrix` and `mutations`. Mutations changed only production code:

1. Slot-a construct ID → `ApiKeyChanged`.
2. Lambda allowed slots → `['b']`.
3. Export `handler` → `mutatedHandler`.
4. Consumer enumeration → `.slice(0, -1).map(...)`.
5. Added one extra API Gateway key.
6. Removed the old-disabled condition from `enabled`.

[Exact mutation commands and failures](/private/tmp/wo-001-review-3i0mmm32/mutation-summary.log).

**Restored:** SHA-256 comparison of all **249 tracked files** against their pre-review bytes found **zero mismatches**, including the registry and all three edited tests. [Restoration evidence](/private/tmp/wo-001-review-3i0mmm32/restoration.json).

Final `git status --short`:

```text
 M infra/test/api-key-rotation.test.ts
 M infra/test/infra.test.ts
 M lambda/src/tests/rotation-checker/handler.test.ts
```

The diff remains **+42/−23 across only those three test files**.