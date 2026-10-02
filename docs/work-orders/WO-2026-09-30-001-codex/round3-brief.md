# Codex adversarial review, round 3 — WO-2026-09-30-001, design Revisions 4 and 5

You are the independent reviewer (Codex, Repository Investigator role in
docs/AI_DEVELOPMENT_WORKFLOW.md). The implementer (Claude Code) has implemented the
approved Revisions 4 and 5. Your job is to find defects and to test the implementer's claims
against the design, not to confirm them.

## Ground rules (same as rounds 1 and 2)

- Review only. Do NOT author fixes, patches, or replacement code. Describe defects,
  evidence and consequences; fixes go through a separate implementation cycle.
- This directory is a disposable snapshot of the implementer's working tree. Run tests,
  synth, and temporary mutations freely, but restore every file and leave `git status`
  clean before you finish, and list the mutations you ran.
- No `npm install`, no network, no AWS calls. Local loopback servers that the tests start
  themselves are fine. Never print, generate or request a real credential value.

## Inputs (review-inputs/)

- `WO-2026-09-30-001-design-rev4-rev5.md` — the approved design and the contract. Revision 4
  covers the Lambda version and `prod` alias deployment boundary (your round-1 F1).
  Revision 5 covers the checker's value-erasing adapter architecture (your round-1/round-2
  F2, F3 and F6). Both are fully approved by Chip. Read the whole document, especially both
  "Required implementation verification" sections. Fixtures specified there may be added
  to, but not narrowed.
- `alias-foundation.diff` — commit 9789f04 on main (917a304): the one-time, behavior-neutral
  alias foundation. It is meant to deploy on its own, before anything else.
- `revision5-and-deploy-boundary.diff` — everything after the round-2 fixes (c993bbb):
  the checker rebuild, the deploy-boundary tests, and the infra test updates. Uncommitted.
- `full-branch-vs-main.diff` — the whole branch against main, for context.
- `round1-codex-findings.md`, `round2-codex-findings.md` — your earlier reports.
- Also binding: `docs/STYLE_GUIDE.md` (esp. §5 testing, §8 credential output).

Commands: `cd lambda && npx jest`, `cd infra && npx jest` (~3–4 min), and
`npx tsc --noEmit -p .` in each. The implementer reports 318/318 Lambda and 63/63 infra,
both type-checking. If your runtime selects an older Node, use the local executables with
Node 22, as you did in round 2.

## What the implementer claims — verify each

### Revision 4: alias foundation and deploy boundary
1. Synthesized against main, 9789f04 leaves the shared function resource byte-identical
   (no code, environment or IAM change). It adds one retained `AWS::Lambda::Version`, one
   `prod` alias and two API-wide alias invoke permissions. It changes all 8 production
   integrations (7 HTTP API, 1 REST) and their 8 per-route permissions to the alias, rolls
   the REST deployment and stage, and introduces no dependency cycle. Check this yourself
   by synthesizing main and 9789f04. You can rebuild main's Lambda dependencies from its
   lockfile only if they're already installed; otherwise say so.
2. Nothing in production invokes the unqualified function or `$LATEST`.
3. The implementer added stage-independent, API-wide alias permissions (`execute-api …
   /{apiId}/*/*/*`). Every HTTP integration, the HTTP default stage, and the REST deployment
   depend on them. The reason given: CDK's per-route REST permission names the stage, so it
   can only be created *after* the stage switches to the alias, which would leave a 500
   window during the foundation deploy. Is that reasoning right, and is the remedy
   sufficient? Can any integration or stage still go live before the alias can be invoked,
   and are there CloudFormation update/replacement orders (permission `FunctionName`
   replacement, old permission deletion at cleanup) that open a gap? Do the API-wide
   permissions widen access beyond the design's intent ("scoped/generated for the qualified
   alias target")? Flag this as a design deviation if you think it is one.
4. A version is published exactly when the function's code or configuration changes,
   rotation phases each publish their own version, and an unrelated change doesn't churn it.
5. The deploy-boundary model (`lambda/src/tests/consumer-auth-deploy-boundary.test.ts`):
   for deploys 1 and 3 in both CloudFormation update orders, every stage returns 200
   through `prod`; the between-calls stage resolves to the old version; the `$LATEST`
   negative control still returns 503; alias-propagation adjacency holds for deploys 1–3.
   This is a model of AWS semantics. Judge whether it faithfully represents the documented
   Lambda/CloudFormation behavior the design cites, and whether it could pass while the
   real deployment fails (STYLE_GUIDE §5: a mock must match the real service).
6. The design's foundation smoke-test list names a "legacy ingestion route" on the HTTP
   API. The implementer reports that this route no longer exists (retired in #39), so the
   HTTP API has only 7 query/fleet routes. Confirm.

### Revision 5: checker value safety
7. Module boundaries per the design: only `lambda/src/rotation-checker/metadata-adapter.ts`
   references `@aws-sdk/client-api-gateway`; it exports only `listKeyMetadata`; it has no
   output capability; the core and records import no SDK; emitters accept only
   `RotationEvent` / `RotationRunSummary`; the handler composes them and throws only a fixed
   local error. Look for any route by which an upstream response, item, error, or anything
   derived from one can reach output-capable code. Consider: the SDK's own middleware or
   logger, `$metadata`, the `name` string itself, `id` content (charset-checked only),
   Date objects, thrown errors from the core, the Lambda runtime's handling of a thrown
   error or rejected promise, and unhandled rejections or timeouts.
8. The adapter sends only `GetApiKeysCommand` with `includeValues: false`, paginated with
   opaque positions, and never `GetApiKey` or `GetUsagePlanKeys`. The implementer verified,
   by replaying a response through the installed SDK, that a `GetApiKeys` page carries `id`,
   `name`, `enabled` and `createdDate` per item (wire `item` → `items`, epoch seconds →
   Date). Confirm independently. Note any remaining gap: this shows what the SDK parses, not
   what the live service sends.
9. The checker role now has only `apigateway:GET` on `/apikeys` plus `sns:Publish` on its own
   topic. The whole-template test claims to catch any reference to the checker role
   (Ref, GetAtt, literal role name, principal in a resource policy). Try to break it.
10. The boundary tests prove exact values crossing the adapter, emitter and handler
    boundaries for hostile pages and failures (getters never evaluated, symbols,
    non-enumerables, a Proxy error that records any access, wire-level errors with the
    sentinel in headers or body), not absence from a list of output channels. Are they
    complete against the design's list? Are any of them unable to fail?
11. The production-handler fixture gives every registered consumer its own attributable
    event and asserts the exact consumer set. The infra entry-point test executes the
    configured export of the synthesized asset against a local fake endpoint. Do these
    close your round-2 R2-3 and R2-4? Re-run your round-2 survivors that still apply
    (fixed clock, first-consumer-only, ingestion entry or asset substitution, Python
    runtime, policy attached by role name, SNS topic policy, Lambda resource permission).
12. Compile-time negative fixtures (`boundary-types.test.ts`) fail with TS2578 when a
    boundary type accepts `value`, an SDK type, an `Error` or a string. The architecture
    test enforces the module rules. Confirm both can fail for the right reason.
13. Round-2 F5 and F7 remain closed (both reported closed in round 2). F5's tests moved to
    `rotation-core.test.ts` with the same semantics.
14. The implementer ran 29 mutations (20 Lambda, 9 infra) and reports all caught. Run your
    own campaign, aimed at the style guide's categories: not called / wrong value in /
    wrong value out / wrong branch / wrong config / silent failure / wrong timing.

### Process
15. The implementer put the alias foundation on its own branch
    (`impl/wo-2026-09-30-001-alias-foundation`, commit 9789f04 on main) and rebased the
    mechanism branch onto it, so the foundation can be reviewed and deployed alone, as the
    design requires. Anything in the mechanism commits that the foundation depends on, or
    the reverse?

## Output format

1. Verdict per claim group: Revision 4 (1–6), Revision 5 (7–13), mutations (14), process
   (15) — each `Verified`, `Verified with findings`, or `Defects found`.
2. Findings, most severe first: severity (blocking / should-fix / note), file:line, the
   concrete failing scenario (inputs → wrong outcome), the evidence (commands, mutation
   results), and whether you reproduced it or reasoned it only. Flag explicitly anything
   you believe deviates from the approved design.
3. Mutations you ran and their results.
4. Anything you could not verify, and why. Confirm the tree is clean.
