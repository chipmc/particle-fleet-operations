# Codex adversarial review — WO-2026-09-30-001 implementation (commit b316b27)

You are the independent reviewer (Codex, Repository Investigator role in
docs/AI_DEVELOPMENT_WORKFLOW.md). The implementer was Claude Code. Your job is to find
defects and to test the implementer's claims, not to confirm them. Treat every claim
below as unverified until you have reproduced it yourself.

## Ground rules

- Review only. Do NOT author fixes, patches, or replacement code. Describe each defect,
  its evidence, and its consequence; fixes go through a separate implementation cycle.
- This directory is a disposable snapshot of the branch (git repo initialized locally;
  HEAD = snapshot of b316b27). You may run tests, synth, and make temporary mutations to
  test coverage, but `git checkout -- .` / `git status` clean before you finish, and say
  which mutations you ran.
- Do not run `npm install` or anything touching the network. node_modules are present.
- Do not call AWS. There are no credentials and no deployed-state questions here.
- Never print, generate, or request a real credential value.

## Inputs (review-inputs/)

- `WO-2026-09-30-001-design-rev3.md` — the approved design (PR #44, revision 3). This is
  the contract. Its "Required implementation verification" section specifies the test
  fixtures; the implementer may add cases but may not narrow them.
- `wo-implementation.diff` — full diff main (917a304) → b316b27.
- `commit-message.txt` — the implementer's summary.
- Also binding: `docs/STYLE_GUIDE.md` (esp. §5 testing, §8 credential output) and
  `docs/AI_DEVELOPMENT_WORKFLOW.md`.

Commands: `cd lambda && npx jest`, `cd infra && npx jest` (infra synths several stacks,
~40s), `npx tsc --noEmit -p .` in each.

## Decisions already approved by Chip — do not re-litigate, but DO check they're implemented as stated

1. A request presenting a known API key whose consumer's key config is malformed gets
   503 (`credential_config_unavailable`) even if the secret is wrong — not 401.
2. The config-error result/log lists every consumer claiming a flagged key ID
   (`consumerIds`, plural).
3. Checker key-count logic follows the design: 1 key with no declared rotation is the
   normal state (no alert); 0, 1-with-declared-rotation, duplicates/3+, or missing dates
   alert.

## Review areas (report a verdict on each)

### A. Auth path — lambda/src/consumer-auth.ts (+ lambda/src/api-key-slots.ts)
The design requires the key lookup to return a tagged result
(consumer / config-error / unknown) built independently per consumer, so malformed
rotation config for one consumer yields 503 for that consumer only, never for others.
Check, adversarially:
- Is there ANY input (env vars, registry content, key ID presented, secret presented,
  consumer ordering, inactive consumers, empty strings, IDs shared across consumers,
  an ID equal to another consumer's env var value) under which one consumer's
  misconfiguration changes another consumer's outcome (status code or resolved
  consumer)?
- Is the pair check (key consumer == secret consumer) still the final authorization
  decision in every success path? Can a key resolve to a consumer it doesn't belong to?
- Constant-time property: are all candidate secrets hashed and compared on every path
  except the pre-existing missing-secret fast path? Does the lookup or config-error path
  introduce any data-dependent early return before the comparison loop finishes?
- Duplicate-secret detection unchanged?
- Anything logged that could contain a credential value?
- Runtime vs synth validation drift: can the bundled registry pass synth but be
  interpreted differently at runtime, or vice versa?

### B. Rotation checker IAM boundary — lambda/src/api-key-rotation-checker.ts and its
### IAM policy in infra/lib/infra-stack.ts
The implementer's stated position: the checker role has `apigateway:GET` on
`/apikeys` and `/apikeys/*` plus `sns:Publish` on its own topic; IAM cannot distinguish
`includeValue(s)=true` from `false`, so the role is technically capable of READING key
values; only the code (and its tests) keep values out.
Establish independently, from the synthesized policy and AWS IAM semantics as you
understand them:
- Exactly what this role can and cannot do. In particular: can it read a key value?
  Can it create, modify, enable/disable, delete, or re-associate keys, usage plans, or
  stages? Can it read values via any other route (usage plans, exports, stages,
  `GetApiKeys` with `includeValues`)? Can it publish anywhere other than its own topic?
- Separate clearly: what is STRUCTURALLY impossible for this role (no policy grants it)
  versus what is merely not done by current code. Do not accept "the code doesn't do X"
  as evidence for "the role can't do X".
- Are the test-harness guards (fake API Gateway refusing value-returning commands,
  source-import check) actually capable of failing for the regressions they claim to
  catch? Any route by which the checker could obtain or emit a value that they miss
  (e.g. a different command class, a raw client call, a dynamic import, error messages
  that embed response bodies, SNS message construction)?
- Is anything about this role inherited (managed policies, Lambda basic execution,
  log-retention custom resource) that widens it?

### C. Two-key-slot CDK logic — infra/lib/infra-stack.ts, infra/lib/ingestion-consumers.ts
Design requirements: no rotation by rename; slot `a` keeps today's logical IDs so
rollout replaces nothing; slots alternate across rotations (promoting `b` keeps its
resource and deletes `a`; the next rotation recreates `a`).
- Verify the logical-ID claims yourself by synthesis. The implementer pinned literal
  pre-change logical IDs recorded from a synth of main; check that the
  ingestion-consumer ApiKey/UsagePlan/UsagePlanKey resources on the checked-in registry
  are identical to main's. A buildable export of main (917a304) with its own
  node_modules is at `main-917a304/` (not part of the snapshot's git tree); synth it
  with `cd main-917a304/infra && npx cdk synth --context
  archiveOperatorPrincipalArn=arn:aws:iam::123456789012:role/test-archive-operator -o
  /tmp/<dir> --quiet` and compare templates yourself, rather than trusting the literals
  in infra/test/api-key-rotation.test.ts.
- The implementer relies on CDK's `APIGATEWAY_USAGEPLANKEY_ORDERINSENSITIVE_ID`
  behaviour (usage-plan-key logical ID derived from the key's construct path). Is that
  flag actually in effect here, and what breaks if it isn't or changes?
- Walk every phase transition (baseline → overlap → old-disabled → cleanup → reverse
  overlap → reverse cleanup) and every rollback the design allows (old-disabled →
  overlap). Does any transition replace, rename, or delete a key or association it
  shouldn't, or produce a CloudFormation update that would fail (e.g. name or
  association conflicts, ordering)?
- Env var wiring: primary var follows primarySlot; rotation var only during rotation.
- Registry validation: collisions (alpha vs alpha-b), unknown/timestamp fields,
  rotation on inactive consumers, schemaVersion.
- Confirm nothing removed by the design has been reintroduced: deploy blocking of any
  kind, a registrar, SSM anchor parameters, an intent parameter, or a Lambda-side
  deadline.

### D. Mutation testing coverage
The implementer reports running 21 mutations (6 consumer-auth, 10 checker, 5 infra);
20 caught. The one survivor: making the checker copy the whole GetApiKey/GetApiKeys
response object into its internal KeyMetadata record (`{ ...item, id, name, ... }`).
The implementer's argument that it is non-exploitable: alerts and logs are built only
from a second fixed field list (`summarize()` → id/slot/enabled, plus explicit event
fields), so a value carried on the internal record never reaches output; they
report that mutating BOTH layers is caught (3 failures, including the leak test).
- Evaluate that argument. Is the second whitelist really the only path from the
  internal record to any output (SNS Message, Subject, console logs, thrown error
  messages, return value used anywhere)? Would a plausible future edit (e.g. logging a
  record for debugging, adding a field to the event) leak a value without any test
  failing? Should this be treated as acceptable defence-in-depth or as a coverage gap?
- Run your own mutations where you think coverage is thin, especially in the
  categories the style guide lists: not called / wrong value in / wrong value out /
  wrong branch / wrong config / silent failure / wrong timing. Report which survive.
- Are any of the design's specified fixtures missing, narrowed, or re-encoded (e.g.
  the 1 ms-before/at/after boundary, the `+08:00` second-precision createdDate, the
  alpha / alpha-long exact-name fixture, the alpha / alpha-b collision, the
  0/1/2/3-key states, the disabled-key-still-counts case)?
- Does any mock diverge from the real service in a way that makes a test pass when
  production would fail (the style guide's ExclusiveStartKey lesson)? In particular the
  fake API Gateway's pagination, createdDate type, and GetApiKey behaviour.

## Also flag

Anything else you find that is a correctness, security, or contract defect, even outside
A–D. Ignore pure style unless it violates docs/STYLE_GUIDE.md.

## Output format

1. Verdict per area A–D: one of `Verified`, `Verified with findings`, `Defects found`.
2. Findings, most severe first. For each: severity (blocking / should-fix / note),
   file:line, the concrete failing scenario (inputs → wrong outcome), and the evidence
   you gathered (command run, test or mutation result). Mark each as reproduced by you
   or reasoned only.
3. Mutations you ran and their results.
4. Explicit answer to: "Is the checker role structurally incapable of acting on a key
   value?" — distinguishing reading a value from acting on/mutating keys.
5. Anything in the implementer's claims you could not verify, and why.
