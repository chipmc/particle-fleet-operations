AGENT: Codex · MODEL: gpt-6-astra · REASONING: high
AUTHORIZATION SCOPE: review only; run tests and temporary mutations in this disposable snapshot and restore every file byte-for-byte / not authorized: authoring fixes or patches, npm install, network, AWS calls, deleting anything you didn't create.

# WO-2026-10-08-001 — narrow verification: did any test assertion become vacuous?

Test-only change (see `git diff`, +42/−23 = net +19): six tests that pinned the checked-in
registry (`config/ingestion-consumers.json`) to "slot a, no rotation" were rewritten so the
suite passes with the checked-in registry in any of four states: steady, overlap
(`rotation: {secondarySlot:'b', phase:'overlap'}`), old-disabled, and `primarySlot:'b'`.
No `lambda/src` or `infra/lib` source changed.

The six:
1. infra/test/api-key-rotation.test.ts "slot a keeps the exact logical IDs…": now synthesizes the checked-in consumers forced to steady state (fixture), recorded IDs still hard-coded.
2. same file, "the checked-in registry is valid…": now loads the live file and asserts the Lambda's `apiKeyConfigProblem` finds nothing; slot/phase specifics left to the fixtures in that file.
3. same file, deployed entry-point test: feeds each consumer only a key whose name matches neither slot and expects `no_keys` per consumer (state-independent; no copy of checker logic).
4. infra/test/infra.test.ts "registry-driven per-consumer resources…": expected keys (names, Enabled) derived from the checked-in file with the naming/old-disabled rule written out in the test, not imported from infra/lib; compared to the synthesized template.
5–6. lambda/src/tests/rotation-checker/handler.test.ts (lines ~87 and ~141 now): jest.mock of the registry JSON gives handler and test the real consumer IDs in steady state.

## Questions — answer each explicitly with evidence (commands and results)
1. Is any rewritten assertion vacuous, i.e. would it still pass if the behavior it protects were broken? For each of the six, name the behavior it protects and run at least one mutation of the code under test (not of the test) that it must catch. Report each result.
2. Specifically confirm: (a) the handler tests (5–6) fail if the checker skips a consumer; (b) infra's entry-point test (3) still executes the real synthesized bundle with the real checked-in registry (not a mock), e.g. by showing the jest.mock in the lambda test cannot affect the infra test.
3. Does test 4 compute its expectation from the same source it tests (the template, or infra/lib code)? Does it fail if the stack creates a third key, and if the old-disabled primary is left enabled?
4. Run both suites with the checked-in registry in each of the four states; report counts. Restore the file afterwards.

Start with `VERDICT: CLEAN` or `VERDICT: PROBLEM`, then one section per question, then the mutations you ran and confirmation that `git status` shows only the three modified test files.
