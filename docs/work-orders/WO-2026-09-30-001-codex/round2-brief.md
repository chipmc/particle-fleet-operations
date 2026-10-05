# Codex adversarial review, round 2 — WO-2026-09-30-001 should-fix findings

You are the independent reviewer (Codex, Repository Investigator role in
docs/AI_DEVELOPMENT_WORKFLOW.md). The implementer (Claude Code) says it has closed
findings F2, F3, F5, F6 and F7 from your round-1 report
(`review-inputs/round1-codex-findings.md`). Test that claim; do not accept it.

## Ground rules (same as round 1)

- Review only. Do NOT author fixes, patches, or replacement code. Describe defects,
  evidence and consequences; fixes go through a separate implementation cycle.
- This directory is a disposable snapshot: commit b316b27 plus the round-2 fixes, which
  are still uncommitted on the implementer's branch. Run tests, synth, and temporary
  mutations freely, but restore every file and leave `git status` clean before you finish,
  and list the mutations you ran.
- No `npm install`, no network, no AWS calls. Never print, generate or request a real
  credential value.

## Inputs (review-inputs/)

- `round1-codex-findings.md` — your round-1 report.
- `round2-fixes.diff` — exactly what changed since b316b27 (4 files).
- `wo-implementation-b316b27.diff` — the full WO implementation as of b316b27, for context.
- `WO-2026-09-30-001-design-rev3.md` — the approved design (the contract).
- Also binding: `docs/STYLE_GUIDE.md` (esp. §5 testing, §8 credential output).

Commands: `cd lambda && npx jest`, `cd infra && npx jest` (~60s), `npx tsc --noEmit -p .`
in each. Implementer reports 273/273 lambda and 46/46 infra.

## Scope

In scope: F2, F3, F5, F6, F7, and any regression or new defect the round-2 changes
introduce.

Out of scope this round. Do not re-report these as new findings; you may say whether the
round-2 changes alter them:
- **F1** (deploy-time code/environment skew → transient 503) is a design question, being
  handled separately in a Phase 3 design revision.
- **F4** (runbook and the `"-"` 403 fixture) is deferred to Phase 7 by Chip's decision.

## What the implementer says it did — verify each

- **F2:** the checker's leak assertions now capture every console method (log, info,
  warn, error, debug, trace) plus raw `process.stdout.write`/`process.stderr.write`, and
  include the run's returned events and the thrown error's message and stack.
  Re-run your surviving mutations (`console.warn(item)` in response conversion; whole
  response copied into the record and then logged). Then look for output paths still not
  covered — e.g. `console.dir`, `console.table`, `process.emitWarning`, a value carried
  on the returned events, error `cause` chains, SNS `MessageAttributes`, or anything
  else plausible. Is the hostile-mode (`leakValues`) fixture exercised on enough code
  paths to catch a leak there (list, detail read, error, publish)?
- **F3a:** a new test runs the exported production `handler` against the real bundled
  registry, with SDK client `send` stubbed through the value-refusing fake, and asserts
  the topic ARN from the environment and the published events; a missing topic ARN must
  throw before any API Gateway call. Does it really catch a handler that does nothing, or
  that runs the check with the wrong consumers, the wrong topic, or a fixed clock? Is it
  robust to the registry gaining or losing consumers?
- **F3b:** an infra test loads the synthesized checker asset from the cloud assembly and
  asserts the configured `Handler` resolves to an exported function. Re-run your
  `handler: 'missingHandler'` mutation. Are there other ways the deployed entry point
  could be wrong while this passes (wrong entry file, wrong runtime, wrong asset)?
- **F3c:** an infra test pins the checker role's entire permission surface: managed
  policy ARNs exactly `[AWSLambdaBasicExecutionRole]`, no inline `Policies` or
  permissions boundary on the role, no `AWS::IAM::ManagedPolicy` attached, exactly one
  attached `AWS::IAM::Policy` with an exact statement list. Re-run your
  `AmazonAPIGatewayAdministrator` mutation. Can a broadening still slip through? Think
  about: a policy attached by role *name* rather than `Ref`; a resource-based policy (e.g.
  on the topic, or a Lambda permission) that widens what the checker can do; the role
  being swapped for a different or imported role; grants made through a different
  construct.
- **F5:** with one key, no declared rotation, and a missing, unparseable or invalid
  `createdDate`, the checker now publishes `missing_created_date` instead of reporting
  healthy. Check that this doesn't break the approved normal one-key state (Chip decision 3:
  one key with no declared rotation does not alert when its metadata is good), and that
  the one-key path still makes no `GetApiKey` calls. Are any other key-count paths still
  able to return healthy with unreadable metadata?
- **F6:** `GetApiKeys` failures are re-thrown as
  `GetApiKeys failed: <name> (HTTP <status>, request <requestId>)`. Each field is relayed
  only if it matches `^[\w.:-]+$`, otherwise `unknown`; upstream message text is never
  relayed. The implementer checked AWS's GetApiKeys API reference: it lists
  BadRequestException (400), NotFoundException (404), TooManyRequestsException (429) and
  UnauthorizedException (401), but documents no message text ("see the accompanying error
  message for details"), so an echoed value can't be ruled out. Is the sanitizer complete?
  Can upstream text still escape: through the error's name or metadata, a `cause`, the
  Lambda runtime's own serialization of the thrown error, or the other error paths
  (`GetApiKey` detail failures, SNS publish failures, a non-AWS exception such as a
  TypeError while parsing a page)?
- **F7:** the shared-key test now asserts the config-error log entries themselves, with
  `consumerIds` sorted to `['alpha', 'beta']`, in both registry orders. Re-run your
  keep-only-the-first-claimant mutation.

Also check that the round-2 changes did not narrow, loosen or re-encode any existing
assertion or any design-specified fixture. The implementer says one existing test fixture
changed: "a GetApiKeys failure fails the whole run" now builds its error with
`name: 'AccessDeniedException'`, because the old fixture relied on raw message
passthrough, which F6 removes. Judge whether that change is legitimate (STYLE_GUIDE §5:
derive changed expectations from the contract, not from what the code now prints).

## Output format

1. Per finding F2, F3 (a/b/c), F5, F6, F7: `Closed`, `Partially closed`, or `Not closed`,
   each with evidence (commands run and mutation results) and whether you reproduced it.
2. New findings, most severe first: severity (blocking / should-fix / note), file:line,
   the concrete failing scenario, and the evidence.
3. Mutations you ran and their results.
4. Whether the round-2 changes alter F1 or F4 in any way (one line each).
5. Anything you could not verify, and why. Confirm the tree is clean.
