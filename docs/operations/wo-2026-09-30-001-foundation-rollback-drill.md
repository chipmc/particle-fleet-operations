# WO-2026-09-30-001 foundation rollback drill (required manual Phase 5/6 step)

**Status:** required before the alias foundation is deployed to production. Not automated.
Repository tests model the rollback (`infra/test/rollback-guards.test.ts`); they cannot
certify the function policy that actually remains after a real rollback, reconciliation,
re-foundation, or guard retirement. This drill does.

**Who:** the AWS Agent runs it in a disposable, non-production stack; Chip reviews the
record and signs off before the production foundation deploy.

**Why:** the design's Revision 6 (R3-2). After the foundation, nothing authorizes API Gateway
to invoke the bare function. If the pre-foundation template were redeployed, its REST
permission names the stage, so it is created only after the stage already serves the bare
function. The foundation adds eight dormant, retained, route-scoped guard permissions so that
rollback has no window of 500s. This drill shows the guards survive rollback, can be
reconciled before re-foundation, are recreated by re-foundation, and can be retired cleanly.

## Rules for every command

- Credential safety (`docs/STYLE_GUIDE.md` §8): no command in this drill may print an API
  key value or a webhook secret. Identify keys by ID only.
- `aws lambda get-policy` returns only the function's resource-based policy (statement IDs,
  effects, principals, actions, resource ARNs, conditions) and a revision ID. It contains no
  credential values (re-confirmed for WO-2026-09-30-001 round 4). Even so, select only the
  fields below.
- `aws lambda remove-permission` and the integration reads below print no credentials.
- Use the drill stack's own test consumer credentials for the REST smoke test, never
  production ones. Only the operator handles their values, in their own terminal.
- Record every result in the drill record (below); "it worked" is not a record.

**Policy inventory query** (used in several steps):

```
aws lambda get-policy --function-name <bare function name> --query Policy --output text \
  | jq '[.Statement[] | {Sid, SourceArn: .Condition.ArnLike["AWS:SourceArn"], SourceAccount: .Condition.StringEquals["AWS:SourceAccount"]}]'
```

**Smoke loop:** at least one request per route per second, all eight routes (table below),
running across the whole of every step marked *(smoke loop)*. **Pass:** no 5xx on any route
at any point.

## Steps

1. **Pre-foundation baseline.** Deploy the pre-foundation template (main at `917a304`) to a
   disposable stack. Smoke-test all eight routes once: each returns its normal status.
2. **Foundation** *(smoke loop)*. Deploy the foundation (the
   `impl/wo-2026-09-30-001-alias-foundation` branch tip).
   - Policy inventory: eight `IngestionRollbackGuard…` statements — seven `/*/GET/<path>` on
     the HTTP API, one `/*/POST/particle/log` on the REST API, each with this account as
     `SourceAccount`. Record their `Sid`s.
   - Confirm CloudWatch shows the published version invoked, not `$LATEST`.
3. **Rollback** *(smoke loop)*. Deploy the pre-foundation template again over the foundation
   stack.
   - Policy inventory: the same eight guard statements (same `Sid`s) are still present
     (CloudFormation removed their resources, but `Retain` left the statements), alongside
     the old template's recreated per-route permissions.
4. **Reconcile retained statements, before any re-foundation** *(smoke loop)*. The design
   requires this first: creating a permission with an existing statement ID can fail.
   - Remove only the eight recorded guard statements, by `Sid`:
     `aws lambda remove-permission --function-name <bare function name> --statement-id <Sid>`
   - Policy inventory: no guard statements remain; the old template's per-route permissions
     are untouched. Traffic is served by those permissions throughout.
5. **Re-foundation** *(smoke loop)*. Deploy the foundation again over the reconciled stack.
   - It must complete without a statement-ID conflict. If it fails, record the exact error
     and stop: the drill has failed.
   - Policy inventory: eight guard statements exist again (record the new `Sid`s) plus the
     alias-qualified permissions. Confirm CloudWatch shows the published version invoked.
6. **Guard retirement (the approved cleanup sequence)** *(smoke loop)*. Run on the
   re-foundationed stack, in exactly this order:
   1. Verify every production integration targets the `prod` alias:
      `aws apigatewayv2 get-integrations --api-id <http api id> --query 'Items[].IntegrationUri'`
      and `aws apigateway get-integration --rest-api-id <rest api id> --resource-id <id> --http-method POST --query uri`.
      Every URI ends in `:prod` (via the alias ARN).
   2. Deploy a drill-only variant of the foundation with the guard resources removed from
      the template. `Retain` keeps their statements in the function policy.
   3. Verify no integration changed (repeat 6.1).
   4. Remove only the recorded guard statements, by `Sid` (as in step 4).
   5. Policy inventory: no guard statements remain; alias-qualified permissions remain.
   6. Smoke-test every route once more after the loop ends.
7. **Tear down** the disposable stack.

The production procedures for re-foundation after a rollback (steps 4–5) and for eventual
guard retirement (step 6) must be the ones this drill proved. Guard retirement in production
is a separate, reviewed operation after Chip declares rollback to pre-foundation templates
unsupported; it is never part of credential rotation.

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
| Step 2: guard `Sid`s, source ARNs, account; invoked version (not `$LATEST`) | |
| Step 3: guard statements still present (same `Sid`s)? | |
| Step 4: statements removed (`Sid`s); inventory after | |
| Step 5: re-foundation result; new guard `Sid`s; invoked version | |
| Step 6: integration URIs before/after; statements removed; final inventory | |
| 5xx count per step (2, 3, 4, 5, 6) | |
| Chip sign-off | |
