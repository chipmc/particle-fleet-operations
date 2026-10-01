# WO-2026-09-30-001 foundation rollback drill (required manual Phase 5/6 step)

**Status:** required before the alias foundation is deployed to production. Not automated.
Repository tests model the rollback (`infra/test/rollback-guards.test.ts`); they cannot
certify the function policy that actually remains after a real rollback. This drill does.

**Who:** the AWS Agent runs it in a disposable, non-production stack; Chip reviews the
record and signs off before the production foundation deploy.

**Why:** the design's Revision 6 (R3-2). After the foundation, nothing authorizes API Gateway
to invoke the bare function. If the pre-foundation template were redeployed, its REST
permission names the stage, so it is created only after the stage already serves the bare
function. The foundation adds eight dormant, retained, route-scoped guard permissions so that
rollback has no window of 500s. This drill shows the guards survive and cover every route.

## Rules for every command

- Credential safety (`docs/STYLE_GUIDE.md` §8): no command in this drill may print an API
  key value or a webhook secret. Identify keys by ID only. `aws lambda get-policy` returns
  the function's resource policy, which holds statement IDs, principals and source ARNs, not
  credentials. Still, select only those fields.
- Use the drill stack's own test consumer credentials for smoke tests, never production
  ones. Only the operator handles their values, in their own terminal.
- Record every result in the drill record (below); "it worked" is not a record.

## Steps

1. **Deploy the pre-foundation template** (main at `917a304`) to a disposable stack.
   Smoke-test all eight routes (below): each returns its normal status.
2. **Deploy the foundation** (the `impl/wo-2026-09-30-001-alias-foundation` branch tip).
   - Before switching traffic, record the guard statements:
     `aws lambda get-policy --function-name <bare function name> --query Policy --output text | jq '[.Statement[] | {Sid, SourceArn: .Condition.ArnLike["AWS:SourceArn"], SourceAccount: .Condition.StringEquals["AWS:SourceAccount"]}]'`
     Expect eight `IngestionRollbackGuard…` statements: seven `/*/GET/<path>` on the HTTP API,
     one `/*/POST/particle/log` on the REST API, each with this account as `SourceAccount`.
   - Smoke-test all eight routes *throughout* the deploy (run a loop, at least one request
     per route per second), then confirm CloudWatch shows the published version invoked,
     not `$LATEST`.
3. **Roll back: deploy the pre-foundation template again** over the foundation stack.
   - Keep the smoke-test loop running across the whole update. **Pass:** no 5xx on any
     route at any point.
   - Afterwards, rerun the `get-policy` query: the same eight guard statements are still
     present (CloudFormation removed their resources from the stack, but `Retain` left the
     statements), alongside the old template's recreated per-route permissions.
4. **Re-foundation conflict check:** deploy the foundation again over the rolled-back stack
   and record what happens to the retained guard statement IDs. If CloudFormation fails on
   an existing statement ID, record the exact error. Then test the reconciliation procedure
   (remove only the recorded retained statements, by `Sid`, with `aws lambda
   remove-permission`) and redeploy. The production procedure for both re-foundation and
   eventual guard cleanup must be the one this step proved.
5. **Tear down** the disposable stack. `Retain` statements disappear with the function.

## Routes to smoke-test

| API | Method and path |
|---|---|
| HTTP API | `GET /device/{deviceId}/timeline` |
| HTTP API | `GET /device/{deviceId}/health` |
| HTTP API | `GET /device/{deviceId}/summary` |
| HTTP API | `GET /device/{deviceId}/anomalies` |
| HTTP API | `GET /fleet/summary` |
| HTTP API | `GET /fleet/anomalies` |
| HTTP API | `GET /fleet/offline` |
| REST API | `POST /particle/log` (with a drill consumer's API key and webhook secret) |

There is no legacy HTTP ingestion route; PR #39 retired it.

## Drill record (fill in)

| Item | Result |
|---|---|
| Date, operator, stack name | |
| Guard statements after step 2 (Sid, source ARN, account) | |
| 5xx count during step 2 / step 3 | |
| Invoked version after step 2 (not `$LATEST`) | |
| Guard statements after step 3 | |
| Re-foundation result and reconciliation used (step 4) | |
| Chip sign-off | |
