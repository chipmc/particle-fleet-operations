# Codex adversarial review, round 4 — WO-2026-09-30-001, design Revision 6 plus round-3 fixes

You are the independent reviewer (Codex, Repository Investigator role in
docs/AI_DEVELOPMENT_WORKFLOW.md). The implementer (Claude Code) has fixed your round-3
findings R3-3 through R3-7, implemented the Revision 6 design for R3-1 and R3-2, and ported
the R3-4 template-reference fix to the foundation branch. Find defects and test the claims;
do not confirm them.

## Ground rules (same as rounds 1–3)

- Review only. Do NOT author fixes, patches, or replacement code. Describe defects,
  evidence and consequences.
- This directory is a disposable snapshot. Run tests, synth, and temporary mutations freely,
  but restore every file and leave `git status` clean before you finish, and list the
  mutations you ran.
- No `npm install`, no network, no AWS calls. Local loopback servers that the tests start
  themselves are fine; if your sandbox refuses loopback listeners (round 3), use the same
  in-process transport you used then and say so. Never print, generate or request a real
  credential value.

## What the snapshot is

The working state as it will be after the pending commits and rebase, none of which exist yet:
- **Foundation branch** (`impl/wo-2026-09-30-001-alias-foundation`): `9789f04` (round-3
  verified) → `dea4057` (R3-4 matcher port, committed) → R3-2 rollback guards (uncommitted).
- **Mechanism branch** (`impl/wo-2026-09-30-001-key-overlap-recovered`): rebased onto the
  foundation, plus the uncommitted Revision 5/6 work and the R3-3 through R3-7 fixes.

Commits are held pending Chip's review of 15 new detect-secrets baseline entries, all in the
recorded fixture `infra/test/fixtures/pre-foundation-917a304.json`. The code under review
won't change in that step.

## Inputs (review-inputs/)

- `WO-2026-09-30-001-design-rev6.md` — the approved design, fully signed off by Chip. Read
  the Revision 6 section and its "Revision 6 implementation verification" list closely;
  fixtures there may be added to, never narrowed.
- `round3-codex-findings.md` — your round-3 report.
- `foundation-port-dea4057.diff` — committed foundation port of the R3-4 matcher.
- `foundation-r32-uncommitted-tracked.diff` — the R3-2 changes to tracked foundation files.
  New files: `infra/test/rollback-guards.test.ts`,
  `infra/test/fixtures/pre-foundation-917a304.json`, and
  `docs/operations/wo-2026-09-30-001-foundation-rollback-drill.md`.
- `mechanism-uncommitted.diff` — the mechanism branch's uncommitted work since `dc0593e`.
- `main-917a304/` (not part of the snapshot's git tree) — a buildable export of main with
  main's own Lambda dependencies, for regenerating the pre-foundation template yourself.

Commands: `cd lambda && npx jest`, `cd infra && npx jest`, `npx tsc --noEmit -p .` in each.
The implementer reports 329/329 Lambda and 79/79 infra on this snapshot, both type-checking.
The foundation branch alone reported 43/43 infra.

## Claims to verify

### R3-1: ID-free checker (design Revision 6)
1. The adapter reads only an item's `name` (for an exact lookup in a registry-derived map),
   `enabled` and `createdDate`. It never reads `id` or `value`. The returned records
   (`ObservedKeySlot`, `MalformedKeySlot`) carry only the registry's `consumerId` and `slot`
   plus `enabled`/`createdDate`/`reason`. No raw name or ID crosses into the core, events,
   summary, logs, SNS, return values, or thrown errors. No ID length or shape check exists
   anywhere, in code or tests. Look for any remaining path by which response-derived text
   reaches output; whether `name` is used for anything except equality; whether labels could
   ever come from the response rather than the registry; and whether any test still depends
   on an ID's shape.
2. Events identify keys by consumer ID and slot only (`secondarySlot`; key summaries
   `{ slot, enabled }`). Duplicate exact names remain an ambiguity inconsistency. Check that
   the Revision 3 fixtures (±1 ms threshold, `+08:00` createdDate, daily 09:00 runs,
   0/1/2/3 keys, disabled key counting, alpha vs alpha-long) are preserved and not narrowed,
   given the contract change from key IDs to slots.
3. Compile-time fixtures reject `id` and raw `name` on every boundary type (TS2578 when
   widened). The architecture test forbids the adapter from referencing `id`, and any checker
   module from carrying an ID field or ID pattern. Confirm both can fail for the right reason.

### R3-2: retained rollback guards (design Revision 6), on the foundation
4. One guard per production method/path (7 HTTP GET routes, 1 REST POST), each an
   `AWS::Lambda::Permission` on the unqualified function: principal
   `apigateway.amazonaws.com`, `SourceAccount` this account, `SourceArn` for that API with
   wildcard stage and exact method/path, and both `DeletionPolicy` and `UpdateReplacePolicy`
   set to `Retain`. Guards are derived from the routes actually defined, not a hand-kept
   list. Every HTTP integration, the HTTP default stage, and the REST deployment depend on
   every guard. Synthesized against `dea4057`, the only changes are the 8 guards and
   `DependsOn` additions, with no cycle. The REST deployment's logical ID is unchanged.
5. No other bare-function permission and no trigger targeting the bare function exists; the
   updated alias tests allowlist exactly the guards. Try to add a bare-function trigger or an
   extra bare-function permission that passes.
6. The rollback-direction model (`infra/test/rollback-guards.test.ts`) uses a recorded,
   reduced extract of main's template. **Verify the fixture against main yourself** by
   synthesizing `main-917a304/` and comparing. The model treats CloudFormation's removal
   of resources absent from the new template, with `DeletionPolicy: Retain` keeping the
   physical permission statement. Is that a faithful model? It also claims to cover the REST
   stage/deployment ordering that produced R3-2. Do the assertions actually demonstrate that
   every old integration is authorized before it can target the bare function? Consider:
   Lambda resource-policy statement IDs; whether the old template's recreated permissions
   could collide with retained statements; HTTP API auto-deploy ordering on rollback; the
   policy size limit; and whether `{deviceId}` in an execute-api source ARN matches requests
   the same way CDK's existing permissions rely on.
7. The live drill can't be automated here, so it's documented as a required manual Phase 5/6
   step: `docs/operations/wo-2026-09-30-001-foundation-rollback-drill.md`. Is the procedure
   complete against the design (GetPolicy verification, smoke tests throughout, re-foundation
   statement-ID conflicts, cleanup)? Does any command it prescribes risk printing a credential
   (STYLE_GUIDE §8)?
8. Is the design's accepted tradeoff implemented exactly as bounded: this account, the two
   existing API IDs, wildcard stage, exact methods/paths, nothing broader?

### Round-3 fixes
9. R3-3: the adapter brand-checks dates with `Date.prototype.getTime` (captured at module
   load) inside a try, so no getter, `Symbol.toStringTag`, or Proxy trap runs.
10. R3-4: `infra/test/helpers/template-references.ts` matches a logical ID in every form
    (Ref, GetAtt array or dotted string, DependsOn, `Fn::Sub` `${Id}` / `${Id.Attr}`), used by
    the checker-role scan and the bare-function scan, on both branches. Try to break it, e.g.
    `Fn::Sub` with a variable map, `Fn::ImportValue`, or `Fn::Join` building an ARN from
    parts.
11. R3-5: the handler fixture pins `checkedAt` inside the call and requires exactly one
    consumer to be overdue on the real clock.
12. R3-6: the SNS client uses `maxAttempts: 1`, and tests count exact wire publishes. The
    adapter's API Gateway reads keep the SDK default retries. The implementer judged "no
    retries" in the design to concern alerts, not idempotent reads, and flagged it for Chip.
    Give your view.
13. R3-7: the architecture test now allowlists the value-free side's imports instead of
    blocklisting them.

### Also
14. Your own mutation campaign across all of the above, aimed at the style guide's categories:
    not called / wrong value in / wrong value out / wrong branch / wrong config / silent
    failure / wrong timing. The implementer reports 31 new mutations, all caught: 6 R3-1,
    8 R3-2 guards, 2 foundation port, and 8 Lambda plus 3 infra on the round-3 fixes, with
    3 of those infra ones being R3-4.
15. Anything else that is a correctness, security, or design-contract defect.

## Output format

1. Verdict per group — R3-1 (1–3), R3-2 (4–8), round-3 fixes (9–13), mutations (14) —
   each `Verified`, `Verified with findings`, or `Defects found`.
2. Findings, most severe first: severity (blocking / should-fix / note), file:line, the
   concrete failing scenario, evidence, and whether you reproduced it or reasoned it only.
   Flag explicitly anything that deviates from the approved design.
3. Mutations you ran and their results.
4. Anything you could not verify, and why. Confirm the tree is clean.
