# Style & Usage Guide — particle-fleet-operations

Base: adapted from Google's [TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

Applies to the whole repository, not only the TypeScript in `lambda/` and `infra/`. Several
rules below were learned in `tools/telemetry`, which is JavaScript; a guide read as
"TypeScript only" would exclude exactly the code that produced the incidents.

This document exists to prevent the same convention from being silently rediscovered — or
silently violated — by a new agent, a new review round, or a future you. When a rule below
traces back to a real incident, the incident is named so nobody has to take it on faith.

## Citing work orders

A work order in **this** repository's history is cited bare: `WO-2026-08-28-004`. A work
order in **another** repository's history is prefixed with that repository's short code and
a slash: `GCC/WO-2026-08-29-001` for `Generalized-Core-Counter`.

Both repositories number their work orders per-day and independently, so identical
identifiers across repositories are expected rather than erroneous — `WO-2026-08-29-001`
denotes this repo's HTTP transport work order in §3 and an unrelated firmware work order in
§5 — and the prefix is what keeps the two distinguishable at a glance.

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
- **Nothing may certify its own output.** A claim needs independent reproduction, not a
  re-read of the artifact that produced it. This applies to a diagnostic that reports values
  read back out of the subsystem under investigation, to a build system asked whether its
  own build is current, and to an agent asserting that its change works because its own test
  passes. Where the reporter and the suspect share a failure mode, agreement between them
  proves nothing. Record the value once, independently, before the suspect operation, so the
  two can be cross-checked. This project has been bitten by every variant: a doubled test
  bound that certified the code that widened it, a deleted budget/test/export triple that
  removed its own evidence, and a mock whose semantics fabricated two regressions that were
  never real.
- **When successive rounds each find a defect in a *different* category, the category set
  itself is untested — adding another round in the category just found will not converge.**
  The correct next step is an explicit enumeration of failure modes against current
  coverage — not called / wrong value in / wrong value out / wrong branch / wrong config /
  silent failure / wrong timing — rather than more ad hoc tests in the latest category. Ask
  what category is not being tested, not what else to test in this one. Five rounds against
  a 60-line change (Generalized-Core-Counter, GCC/WO-2026-08-29-001) and five merge-gate passes
  against WO-2026-08-28-004 both showed this shape: coverage extended reactively to whatever
  the previous round had just found.
- **Status labels ("closed," "fixed," "consolidated," "complete") must state precisely what
  was verified, not the intent behind the work.** "Defect 2: closed" turned out to mean
  "closed for the `--start`/`--until` window path only" once the `watch` cursor path was
  checked (see §3). "Consolidation complete" once had an orphaned duplicate implementation
  with zero call sites survive undetected. When you close something out, name the boundary
  of what was actually checked.

## 6. Firmware repo (Generalized-Core-Counter, C++)

These conventions are authored from this repo but apply to the firmware repo
(`Generalized-Core-Counter`), per the maintenance rule below: a convention that surfaces
belongs in writing wherever it applies. **That repo uses a different toolchain than this
one** — Particle Device OS and the `particle` CLI, versus this repo's Node/TypeScript/Lambda
stack. Do not carry a firmware path or command into work on this repo.

Entries here are the **firmware-specific** form of each rule. Where an incident also
produced a general principle, that principle lives in §5 and is not restated here — §6 is
the toolchain detail, §5 is the rule.

Still to be drafted: a general C++ house style, which should adapt Google's
[C++ Style Guide](https://google.github.io/styleguide/cppguide.html).

- **Verifying that a compile-time flag is genuinely absent from a build requires forcing a
  real rebuild of the affected object — never trust the existing build artifact
  (Generalized-Core-Counter, GCC/WO-2026-08-31-003, week of 2026-08-29).** Any restore
  operation that preserves or backdates mtime can leave a stale object the build system has
  no way to know is stale, and it will then answer confidently and wrongly about whether the
  flag took effect. This is not specific to `mv` from a `.bak` — `cp -p`, `git stash pop`,
  `rsync -t`, archive extraction and an editor's "revert file" all have the same property.
  **Restore a build-config file by rewriting it in place** (an edit, or `cat > file`), which
  advances mtime and forces the rebuild; never by a timestamp-preserving restore. Record the
  build's size output at both flag values — a size matching the *other* setting is the
  signature of a stale link. *Firmware-specific illustration (Particle/Device OS toolchain
  only, does not apply to this repo):* the compiled objects live under
  `~/.particle/toolchains/deviceOS/<version>/build/target/user/platform-<id>-m/<app>/`, not
  the project-local `target/`, which holds link output only — so clearing `target/` does not
  force a rebuild. This produced a real false reading: a build reported the flag=1 text size
  while its source read `0`, and `nm` found a bench-only symbol in a binary that should not
  have contained it. **Why it matters:** this is the property keeping a deliberately
  clock-corrupting bench hook out of default builds. A verification method that a stale
  timestamp can fool will assert that property and be wrong — in either direction. Showing a
  feature present when it is absent costs an investigation; the reverse ships the hook.
- **Diagnostic output about a suspected subsystem is not corroboration of that subsystem
  (Generalized-Core-Counter, GCC/WO-2026-08-31-004, week of 2026-08-29).** A diagnostic event
  that reads its own reported values back out of the thing under investigation — retained
  memory, a suspect peripheral — cannot rule that subsystem in or out, because a fault there
  could corrupt the very values the diagnostic reports. The report and the suspect share a
  failure mode, so agreement between them proves nothing. Where feasible, **record the value
  once, independently, before the suspect operation**, so the two can be cross-checked
  rather than resting on a single self-reported source. (General rule: §5, "Nothing may
  certify its own output.")

- **A reset-survival claim must be verified against the linker map or an explicit `retained`
  declaration — never inferred from how well it explains a symptom — and "survives a reset"
  must not be conflated with "re-initializes on a flash" (Generalized-Core-Counter,
  GCC/WO-2026-08-31-003, week of 2026-08-29).** These are two separate properties with two
  separate proofs, and code needing the second while only verifying the first will fail
  silently. **Named trap:** a `retained` variable's `= false` initializer does *not*
  reliably run when new firmware is flashed. *Firmware-specific illustration
  (Particle/Device OS toolchain only):* Device OS copies initial values into backup RAM only
  when the signature check fails (`wiring/src/user.cpp`, `backup_ram_was_valid_` →
  `system_initialize_user_backup_ram()`), so a flash with power maintained preserves the old
  value. A one-shot latch built on a bare `retained bool` may therefore never arm, and the
  failure is invisible — the device simply does nothing. Pair the flag with a build token
  compared against a compile-time constant, or consult `__backup_ram_was_valid()`. Prove
  placement with `objdump -t` (the symbol should land in `.backup`), not by reading the
  declaration.
- **Document field meaning wherever two similarly-named fields from different subsystems
  could be confused (Generalized-Core-Counter, `docs/FIELD_MEANINGS_REFERENCE.md`).** Log lines that pack
  several subsystems into one string invite silent misreading during incident analysis,
  when the cost of a wrong reading is highest — the `vbus=`/`usbReg=` and `mode=`/`tier=`
  pairs are the established examples. A reader must be able to determine which subsystem
  owns a field without reading the format string. Where a name cannot be made
  self-explanatory, the emitting code carries a comment naming the units and source.

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
