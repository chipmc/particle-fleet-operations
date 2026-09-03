# Style & Usage Guide — particle-fleet-operations

Base: adapted from Google's [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

Applies to the whole repository, not only the TypeScript in `lambda/` and `infra/`. Several
rules below were learned in `tools/telemetry`, which is JavaScript; a guide read as
"TypeScript only" would exclude exactly the code that produced the incidents.

This document exists to prevent the same convention from being silently rediscovered — or
silently violated — by a new agent, a new review round, or a future you. When a rule below
traces back to a real incident, the incident is named so nobody has to take it on faith.

## 1. Formatting

- **Indentation: 2 spaces**, no tabs. (A 4-space search pattern against this file's actual
  2-space indentation caused a misplaced edit during WO-2026-08-28-004 — the edit landed on
  the wrong assertion and briefly broke a test.)
- Line length: 100 cols soft limit.
- Semicolons: required.
- Quotes: single, except to avoid escaping.
- Trailing commas: yes, in multiline literals.

*(Run a formatter — Prettier or equivalent — and treat this section as "what the formatter
enforces," not something to hand-check.)*

## 2. Naming

- `camelCase` for variables, functions, parameters.
- `PascalCase` for classes, types, interfaces, enums.
- `UPPER_SNAKE_CASE` for module-level constants and true constants (e.g.
  `WATCH_DYNAMO_MAX_ROWS`).
- Prefer descriptive names over short ones for anything that crosses a function boundary or
  appears in a public API. Short names (`i`, `n`) are fine only for tight, obviously-scoped
  loop/local variables.
- **Booleans read as a question or a state**, not a bare noun: `truncated`, `isWidened`,
  `hasCollision` — not `truncate`, `widen`.
- **Don't reuse a field name for two different meanings across the codebase.** This has
  caused real confusion twice: `vbus=` (PMIC's VBUS_STAT) vs. the override's actual Nordic
  `usbReg=` predicate; `mode=` vs. `tier=`. If two things are conceptually different, they
  get different names even if that feels redundant locally.

## 3. Cross-boundary data conventions (project-specific — not in any generic style guide)

These exist because this codebase spans multiple producers (firmware `serialLog`, `pdiag`,
webhooks) writing into a shared store, and mismatches here have caused real, hard-to-find
data loss.

- **Timestamp format status (updated post WO-2026-08-28-004):** `eventTime` is still
  inconsistent across producers (`serialLog` emits `.NNNNNN+00:00`, `pdiag`/webhooks emit
  `.NNNZ`). The cross-format sort mismatch this causes (Defect 2) is **fixed on the
  `--start`/`--until` window path only**, both `serial` and `timeline`, merged in
  `540d9cc`. It is confirmed **still live** on the `serial`/`watch` cursor path
  (WO-2026-09-03-001) — same signature, different code path. **Named trap:** making the
  cursor comparison lexicographic looks like the obvious fix and isn't — it reintroduces
  the exact inversion the window-path fix was built to avoid. Do not treat "Defect 2
  closed" as covering every code path that touches `eventTime`; check which path you're
  actually in.
- **Never send a raw producer timestamp string as a DynamoDB query bound without going
  through the shared `buildBoundedTimelineQuery`/`widenTimelineBounds` path.** A
  hand-rolled bound risks silently excluding rows near a boundary — this is exactly how the
  `Boron-Dev-09` collision (a µs-precision row silently omitted by a ms-precision `:start`
  bound) happened. This applies to any new tool built on this data (including the MCP
  telemetry server) — reuse the consolidated path, don't reimplement fetch/paging against
  it.
- **HTTP transport does not inherit the Dynamo-path guarantees above (WO-2026-08-29-001,
  open).** `serial`/HTTP still silently returns 0-of-6 with `truncated:false` on some
  windows — worse than the equivalent Dynamo-path failure, which at least flags. Root
  cause: the Lambda layer re-normalizes an HTTP-sent bound, which undoes the low-sort-form
  property the widen-and-filter approach depends on. This may not be fixable CLI-side at
  all. **Do not assume a fix verified against Dynamo also holds over HTTP** — treat HTTP as
  its own surface requiring its own verification until this WO closes.
- **DynamoDB pagination cursors (`ExclusiveStartKey`) are keys, not offsets.** A mock or
  test double that implements `ExclusiveStartKey` as a positional index into a
  re-filterable list will diverge from real DynamoDB behavior exactly when a query narrows
  its bounds between pages — this produced two false "regressions" (R1/R2) that cost two
  full review rounds in WO-2026-08-28-004 before being traced to the mock, not the code.
  Any DynamoDB mock must sort by **string comparison**, not parsed instant, and be
  cross-checked against the live table — a mock that sorts "correctly" by parsed instant
  cannot reproduce this defect class at all.

## 4. Truncation / completeness contracts

The contract itself lives in [`docs/API.md`](API.md) (see the truncation section). This
section is about how to honour it, not a substitute for it.

Any function that can return a partial result under some cap (page size, row limit, scan
budget, HTTP response size) must:

1. Never report `exit 0` / `truncated: false` on a result it cannot guarantee is complete.
2. **When completeness is genuinely unknowable, bias toward `truncated: true`** — a false
   "this might be partial" costs a caller an unnecessary re-query; a false "this is
   complete" costs them data loss they can't detect.

   **This tie-breaker does not license reporting `truncated: true` on a result you actually
   scanned completely.** `docs/API.md` is explicit that complete bounded results keep
   `truncated: false` and exit `0` on the DynamoDB path; the only sanctioned conservative
   case is the 1000-row HTTP clamp. Reporting truncation on a known-complete result was
   raised during WO-2026-08-28-004 as a deliberate choice, and was then **rejected as a
   regression** against that contract — the change that introduced it was reverted rather
   than documented. Bias conservative only where the uncertainty is real.
3. Any boundary/cap predicate needs a **complete-case test at every independent cap level
   it can trip on** (per-page, per-window, server-side, HTTP-layer) — not just a
   truncated-case test. A predicate correct at one level is not automatically correct at
   another; this exact gap cost multiple review rounds on the original truncation fix
   (PR #18) and again across WO-2026-08-28-004.
4. **A cap that turns out to be a policy choice (bounding cost) rather than a correctness
   requirement should be named and justified as such, not silently treated as part of the
   correctness contract.** WO-2026-08-28-004's Step 0 (a raw-scan/collected-event bound)
   looked like a correctness fix restoring deleted behavior, but was actually an unexamined
   cost-bounding policy — and one of its two sub-bounds was itself causing a flagship
   silent-loss failure. It was removed entirely rather than reintroduced.
   Query-cost-at-scale remains an open, unmeasured question — don't resolve it by re-adding
   an unexamined cap.
5. **A cap that discards rows before a downstream filter runs will silently drop matches.**
   `serial` applies `--grep` after the fetch, so any bound that keeps "the newest N" hides
   older matches entirely. Both of Step 0's bounds did this. If you add a bound, establish
   what filtering happens after it.

## 5. Testing conventions

- **A test or mock that cannot fail, or that passes on both sides of a known defect, is not
  a passing test — it's a missing one.** This has happened at least three times in this
  codebase's history: argument-less HTTP mocks (couldn't detect a wrong query bound), a
  deleted budget/test/export triple (self-certification failure), and a DynamoDB mock's
  positional-offset `ExclusiveStartKey` bug (fabricated two regressions that were never
  real).
- **When fixing a defect, write the test first, run it against the pre-fix code, and
  confirm it fails for the *correct* reason** (not e.g. a `ReferenceError` from a missing
  symbol) before writing the fix itself. A failure for the wrong reason proves nothing.
- If a test's assertion is about to change (not just its wording — its actual expected
  value), that's a contract change and should be called out explicitly in the PR
  description, not left to be inferred from the diff.
- **Derive a changed expectation from the contract, not from what the code now prints.**
  When several assertions change at once, state the contract clause each new value comes
  from. Six assertions were rewritten at the close of WO-2026-08-28-004; each cites
  `docs/API.md`'s completeness rule rather than observed output, which is what made them
  reviewable.
- **Widening or loosening an existing assertion to accommodate new code, without
  independently re-verifying the looser bound is still correct, is itself a
  self-certification failure** — same family as the deleted-mechanism pattern above. A
  doubled query bound in this codebase once concealed a real budget-sizing defect this way;
  the assertion passed, but it had stopped testing anything.
- **The reviewer sets test fixture parameters (dataset size, spill count, collision
  density), not the implementer.** Three separate times in this project's history,
  implementer-chosen fixtures were too small to actually reach the defect they were meant
  to catch. Fixture sizing is a review decision, not an implementation detail. See
  *Verification Fixtures* in [`docs/AI_DEVELOPMENT_WORKFLOW.md`](AI_DEVELOPMENT_WORKFLOW.md)
  for the full statement of this rule.
- **A prescribed fix needs local validation before it's sent to an implementer** — the same
  "verify before reporting" standard applies to "verify before prescribing." A spec formula
  or fix instruction that goes out unverified against real behavior has cost real review
  rounds here.
- **Compare behaviour against the previous revision, not only against expected values.** A
  suite can be green while a regression is live, because tests may encode the
  implementation's behaviour rather than the contract. Measuring the same cells against
  `main` is what surfaced the defects at the close of WO-2026-08-28-004; expected-value
  checks alone had passed.
- **Status labels ("closed," "fixed," "consolidated," "complete") must state precisely what
  was verified, not the intent behind the work.** "Defect 2: closed" turned out to mean
  "closed for the `--start`/`--until` window path only" once the `watch` cursor path was
  checked (see §3). "Consolidation complete" once had an orphaned duplicate implementation
  with zero call sites survive undetected. When you close something out, name the boundary
  of what was actually checked.

## 6. Firmware repo (Generalized-Core-Counter, C++)

Not yet drafted. Should adapt Google's
[C++ Style Guide](https://google.github.io/styleguide/cppguide.html) plus project-specific
conventions already established informally in this project's history, e.g.:

- Reset-survival claims must be verified against the linker map / explicit `retained`
  declarations, never inferred from symptom fit.
- Field-meaning documentation is required wherever two similarly-named fields from
  different subsystems could be confused (the `vbus=`/`usbReg=` and `mode=`/`tier=`
  pattern).
- Build-flag state (what was actually compiled in, not just what's in source) should be
  surfaced at runtime wherever a conditional compile has previously caused a silent
  behavior gap.

## 7. Local build artifacts & tooling filenames

- **Temporary build artifacts (host test binaries, compiled probes, etc.) must use visible,
  descriptive filenames under a gitignored path, never dot-prefixed names in the working
  tree.** Prefer `.build-tmp/rtc_skew_test` over `tests/.t`.
- Reasoning: a dot-prefixed executable that gets compiled and immediately run is exactly
  the signature that should trip EDR. The hidden-file convention added no real benefit here
  — it doesn't even help with `git status`, since `??` doesn't surface dotfiles prominently
  either — while producing a false-positive-looking pattern.
- Confirmed not a one-off: the same shape recurred eleven times across dispatch logs
  (`.rtc_skew_test_bin`, `.ctt`, `.final_check`, `.t`, `.crwt`), all attributable to local
  dev tooling, all benign, but all needlessly alarm-shaped.

## Maintenance

This document should be updated whenever a review round, an investigation, or a postmortem
surfaces a convention that isn't written down anywhere — that's the recurring root cause
this guide exists to close off. Treat "we had to rediscover this" as the trigger to add a
line here, not just fix the immediate instance.

Where a rule cites a contract (truncation semantics, exit codes), the contract in
`docs/API.md` is authoritative and this guide is the commentary. If they ever disagree,
`docs/API.md` wins and this file is the one to fix.
