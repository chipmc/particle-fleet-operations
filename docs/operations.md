# Operations Guide

## Deployment Procedures

### Pre-Deployment Checklist

**Timing:**
- ✅ Deployment scheduled for bottom of hour (:30–:45)
- ❌ Avoid top of hour (:00–:15) when ~500 devices report

**Pre-flight checks:**
1. Verify current Lambda is healthy
2. Check recent CloudWatch logs for errors
3. Confirm recent successful webhook ingestions
4. Note baseline Lambda duration (p50/p99)

### Deployment Steps

#### 1. Build Lambda (5 minutes before deploy)

```bash
cd lambda
npm install
npm run build
npm test
```

**Verify:**
- All tests pass
- No TypeScript compilation errors
- Bundle builds successfully

#### 2. CDK Diff

```bash
cd ../infra
npm install
cdk diff
```

**Verify:**
- Only Lambda code changes
- No S3 bucket changes
- No DynamoDB table changes
- No API Gateway endpoint changes
- No IAM permission changes

**Expected diff:**
```
[~] AWS::Lambda::Function ParticleLogIngestionFunction
 └─ [~] Code
     ├─ [-] ZipFile: ...
     └─ [+] S3Bucket: cdk-assets-...
```

#### 3. Deploy (at :30–:45)

```bash
cdk deploy
```

**Monitor:**
- CloudFormation stack update progress
- Lambda function update (should be in-place, not replacement)

#### 4. Immediate Validation (within 5 minutes)

**Synthetic webhook test:**

```bash
# Test with valid secret
curl -X POST "https://API_ENDPOINT/particle/log" \
  -H "Content-Type: application/json" \
  -H "X-Particle-Webhook-Secret: YOUR_SECRET" \
  -d '{
    "event": "test-deploy-validation",
    "coreid": "test-device",
    "published_at": "2026-06-26T14:30:00.000Z",
    "data": "{\"test\":true}"
  }'
```

**Expected:** `{"ok":true,"stored":true}` with 200 status

**Verify S3:**
```bash
AWS_PROFILE=particle-admin aws s3 ls \
  s3://BUCKET_NAME/particle-events/$(date +%Y-%m-%d)/test-deploy-validation/ \
  --recursive | tail -1
```

**Verify DynamoDB:**
```bash
AWS_PROFILE=particle-admin aws dynamodb get-item \
  --table-name TABLE_NAME \
  --key '{"deviceId":{"S":"test-device"},"eventTime":{"S":"2026-06-26T14:30:00.000Z"}}'
```

**Check CloudWatch logs:**
```bash
AWS_PROFILE=particle-admin aws logs tail \
  /aws/lambda/LAMBDA_NAME \
  --since 5m \
  --filter-pattern "Stored Particle event"
```

**Expected:** Recent log entry with test event

#### 5. Pre-Burst Monitoring (at :55)

**Check Lambda health:**
```bash
# No errors in last hour
AWS_PROFILE=particle-admin aws logs filter-log-events \
  --log-group-name /aws/lambda/LAMBDA_NAME \
  --start-time $(date -u -v-1H +%s)000 \
  --filter-pattern "ERROR"
```

**Expected:** No ERROR entries

**Check Lambda state:**
- CloudWatch Metrics → Lambda → Concurrent Executions
- Should be 0 or near-0 (idle state before burst)

#### 6. Burst Validation (at :00–:15)

**Monitor CloudWatch metrics:**
- Concurrent Executions (should spike to ~50–200)
- Duration (compare to baseline)
- Errors (should be 0)
- Throttles (should be 0)

**Live log monitoring:**
```bash
AWS_PROFILE=particle-admin aws logs tail \
  /aws/lambda/LAMBDA_NAME \
  --follow
```

**Watch for:**
- ✅ "Stored Particle event" log entries
- ❌ Error messages
- ❌ Timeout errors
- ❌ Memory errors

#### 7. Post-Burst Validation (at :20)

**Count ingested events:**
```bash
AWS_PROFILE=particle-admin aws logs filter-log-events \
  --log-group-name /aws/lambda/LAMBDA_NAME \
  --start-time $(date -u -v-30m +%s)000 \
  --filter-pattern "Stored Particle event" \
  | grep -c "deviceId"
```

**Expected:** ~500 events (compare to historical baseline)

**Check for specific device:**
```bash
AWS_PROFILE=particle-admin aws dynamodb query \
  --table-name TABLE_NAME \
  --key-condition-expression "deviceId = :d AND eventTime > :t" \
  --expression-attribute-values '{
    ":d":{"S":"KNOWN_DEVICE_ID"},
    ":t":{"S":"'$(date -u -v-30m +%Y-%m-%dT%H:%M:%S)'"}
  }'
```

**Expected:** Recent event from last burst cycle

**Alternative: Use timeline tool**
```bash
cd scripts
npm run timeline -- --deviceId KNOWN_DEVICE_ID --hours 1
```

See [tools.md](./tools.md) for detailed timeline tool usage.

## Monthly DynamoDB Archive

EventBridge Scheduler starts the Standard Step Functions archive workflow at
02:00 UTC on the first day of each month. It scans only
`ParticleLogEventsTable`, selects rows whose parsed `eventTime` instant is more
than 60 days old, writes gzip JSONL shards under
`dynamodb-index-archive/v1/`, reads them back, verifies every item digest, and
rereads source rows for race detection.

Phase 1 is copy-and-verify only:

- `ARCHIVE_DELETE_ENABLED=false` is fixed in CDK.
- The archive role has no `dynamodb:DeleteItem` permission.
- `DeviceCurrentState` and `DeviceEventHistory` are not scanned or changed.
- No Athena, restore, or archive-aware query path exists yet.

The job and any historical-key rewrite share a single DynamoDB lock item,
`LOCK#monthly-archive` / `METADATA` in the `ArchiveCoordination` table
(`lambda/src/archive-coordination.ts`), rather than an S3 object. Acquiring it
atomically increments a fencing token; every subsequent action (`PROCESS_PAGE`,
`FINALIZE`) asserts that token is still current before doing any work, so a
crashed-and-retried execution can never race a still-running one. Releasing the
lock clears ownership fields with a conditional `UpdateItem` — it never deletes
the item, so the fencing token itself is never lost or reset.

See `docs/architecture.md` for the canonical statement of this lock/fencing
contract, including that `WO-2026-08-28-003`'s not-yet-built backfill must
acquire this same lock and honor its current fencing token before any
delete-and-reinsert rewrite of archived/archiving rows. Do not bypass the lock
manually; if it is genuinely stuck, use the break-glass procedure below.

### Deployment And Dry Run

1. Review `cdk diff`. Expected additions include the archive Lambda, the
  `ArchiveCoordination` DynamoDB table, Standard workflow, scheduler, SNS
  topic/subscription, alarms, a reconciliation dead-letter queue, the
  break-glass `ArchiveLockBreakGlassRole`, S3 lifecycle, and least-privilege
  IAM policies. No existing DynamoDB table should be replaced, and the archive
  Lambda's own role should carry no `dynamodb:DeleteItem` grant — that
  permission exists only on `ArchiveLockBreakGlassRole`, scoped to the lock
  partition key. Deploying requires the `archiveOperatorPrincipalArn` CDK
  context value; synth fails closed without it.
2. Deploy and confirm the subscription email sent to `chip@seeinsights.com`.
  SNS does not deliver run reports until that subscription is confirmed.
3. Start one manual workflow execution from the Step Functions console or CLI.
4. Verify the final report at
  `dynamodb-index-archive/reports/YYYY/MM/{run_id}.json` has
  `deletionEnabled: false` and `counts.deleted: 0`.
5. Verify shard manifests report matching copied/verified counts and inspect
  the `ParticleFleetOperations/Archive` CloudWatch metrics.
6. Query representative source keys from DynamoDB and confirm they still
  exist. Any deletion is a release blocker in this phase.

The SNS topic receives every final run summary. `PARTIAL` and `FAILED` reports
include retained rows or failed shards, and the CloudWatch alarm notifies the
same topic if no completion is recorded during days 1-7 of the month. Every
failure path — the in-workflow Catch *and* the external EventBridge cleanup
rule for failures that bypass Catch entirely (timeout, abort, Step Functions
history exhaustion) — now calls the same unified, idempotent
`RECONCILE_FAILURE` operation (`reconcileFailure` in
`archive-coordination.ts`). It freezes failure evidence once, writes the report
to S3 exactly once (`IfNoneMatch`, first-write-wins under a claim token),
**commits that report, then releases the lock, and only then attempts the SNS
notification** — in that order — so an SNS failure never blocks or unwinds an
already-committed report or already-released lock. A released lock is
evidence the report was written; it is not evidence the notification went out.
Notification-send itself is claim-token guarded to prevent two concurrent
callers from both publishing, but it is not exactly-once end-to-end: if a
claim holder crashes mid-publish, a second caller can reclaim and publish
again after the claim's short lease expires, producing at most one duplicate
notification (see Finding 3 in `docs/architecture.md`) — treat a duplicate
notification as expected, not as a separate failure to investigate. A failed-run report is written to
`dynamodb-index-archive/v1/reports/YYYY/MM/<sha256(executionArn)>.failed.json`;
the report body itself still carries both the human-readable `runId` and the
full `executionArn`, so the hashed filename never loses that context. If
`reconcileFailure` itself keeps failing (e.g. the coordination table is
unreachable), the EventBridge target's dead-letter queue captures the event
and a CloudWatch alarm on that queue's depth pages the same SNS topic.

S3 expires DynamoDB index snapshots after 730 days, including noncurrent object
versions. Retention for existing `particle-events/` raw objects is unchanged
and outside this work order. Reassess the index-archive policy after one year
of production usage before deciding whether to extend it.

### Break-Glass Recovery

The archive lock has a 24-hour lease, so a crashed or stuck execution
self-heals within a day without operator action in almost every case. Use
manual recovery — `tools/archive-lock-release` — only when both are true:

1. The lease has genuinely expired or is about to, **and**
2. You have confirmed, via the Step Functions console or
  `aws stepfunctions describe-execution`, that no execution actually owns the
  lock anymore (it is `SUCCEEDED`, `FAILED`, `TIMED_OUT`, or `ABORTED`).

Required steps, in order — do not skip or reorder these:

1. **Open or reference an incident/ticket first.** The tool requires
  `--ticket <id>` and refuses to run without one.
2. **Run with `--dry-run` first** and read the printed `aws dynamodb
  delete-item` command before running it for real. The tool never reads the
  lock before deleting it — the DynamoDB `ConditionExpression` (exact owner
  execution ARN and fencing token) is the sole authority for whether the
  delete is safe, so getting `--owner-execution-arn` and `--fencing-token`
  right matters.
3. **Run it for real**, then **record the tool's full output and the ticket
  ID in the operations log.** This is required, not optional — it is how a
  manual override of an automated safety mechanism stays auditable.

The tool itself never lists or reads the lock item, and its IAM role
(`ArchiveLockBreakGlassRole`) grants nothing beyond `dynamodb:DeleteItem`
scoped to the `LOCK#monthly-archive` partition key and
`states:DescribeExecution` — it cannot touch a `RUN#...` item, cannot list or
describe stacks, and cannot delete anything in any other table. Pass
`--table <name>` explicitly when running under this role: the default
auto-detection path (reading the coordination table name from the
CloudFormation stack's outputs) calls `cloudformation:DescribeStacks`, which
this role deliberately does not grant, so auto-detection will fail with
`AccessDenied` under the intended identity. (The tool reports this clearly
and tells you to pass `--table` — it is not a silent failure — but knowing
the table name ahead of time avoids the round-trip.)

`dynamodb:DeleteItem` on this table is a CloudTrail **data event**, not a
management event — unlike most IAM-authenticated API calls, it is only
captured if a trail or event data store has data-event logging explicitly
enabled for this table (or for DynamoDB generally). This stack does not
configure that. Before relying on CloudTrail as the audit trail for a
break-glass delete, confirm such a selector actually exists and covers this
table; if it doesn't, the ticket logging above is the *only* audit trail this
action has, not a supplement to one.

Only a principal matching the `archiveOperatorPrincipalArn` CDK context value
can assume `ArchiveLockBreakGlassRole` — this is the first human-assumable
role in the stack, and `cdk synth`/`cdk deploy` fail closed if that context
value is not set.

**Operator principal**: `archiveOperatorPrincipalArn` (set in `cdk.json`)
currently points to this account's SSO AdministratorAccess role
(`AWSReservedSSO_AdministratorAccess_...`). This is acceptable as a
single-operator account — anyone who can assume it already has full admin,
so the break-glass role's narrow scoping mainly guards against accidental
misuse, not against needing broad access to invoke recovery at all. Revisit
this if a second operator without full admin access is ever added — at that
point, point this at a dedicated, narrowly-scoped role instead.

#### 8. Declare Success

**Criteria:**
- ✅ Synthetic webhook test successful
- ✅ S3 raw event stored
- ✅ DynamoDB record indexed
- ✅ No errors in CloudWatch logs
- ✅ Top-of-hour burst handled normally
- ✅ Device count matches historical baseline
- ✅ Lambda duration within normal range

**If all criteria met:** Deployment successful ✅

---

## Rollback Procedures

### Automatic Rollback

CloudFormation will automatically rollback if:
- Lambda deployment fails
- Health checks fail during deployment

**Monitor CloudFormation stack:**
```bash
AWS_PROFILE=particle-admin aws cloudformation describe-stack-events \
  --stack-name InfraStack \
  --max-items 10
```

### Manual Rollback

**Option 1: CloudFormation rollback**
```bash
# Trigger stack rollback to previous version
AWS_PROFILE=particle-admin aws cloudformation cancel-update-stack \
  --stack-name InfraStack
```

**Option 2: Git revert + redeploy**
```bash
git revert HEAD
cd infra
cdk deploy
```

**Option 3: Restore previous Lambda code (emergency)**
```bash
# List previous versions
AWS_PROFILE=particle-admin aws lambda list-versions-by-function \
  --function-name LAMBDA_NAME

# Update alias to previous version
AWS_PROFILE=particle-admin aws lambda update-alias \
  --function-name LAMBDA_NAME \
  --name PROD \
  --function-version PREVIOUS_VERSION
```

### Legacy HTTP API Route Restoration

This is specific to retiring `POST /particle/log` on the legacy HTTP API
(`ParticleLogIngestionApi` / `httpApi` in `infra/lib/infra-stack.ts`) as the final step of
the per-consumer credentials migration (see
`docs/security/webhook-secret-rotation-runbook.md`, "Planned: per-consumer credentials").
The generic options above (stack rollback, redeploy a previous Lambda version) don't apply
here — retiring the route is a deliberate code change, not a failed deployment, so bringing
it back means reverting that specific change, not "undoing a bad deploy."

**Important: this restores only the `POST /particle/log` route, not the whole HTTP API.**
`httpApi` also serves the six `GET /device/{deviceId}/...` query endpoints
(`infra/lib/infra-stack.ts:568` onward) — those are untouched by retirement and must stay
untouched by any rollback. Do not delete or recreate `httpApi` itself.

#### Trigger conditions

Restore the legacy route if, after retirement:
- **A consumer is discovered still depending on it** — e.g., a device, script, or webhook
  not in the known six-webhook-plus-Pi-forwarder list from this migration, missed during
  the pre-retirement observation window, whose traffic only becomes visible once it starts
  failing (404/no route) instead of silently succeeding.
- **An unexplained failure spike appears on the REST API** (`ingest.seeinsights.com`) after
  retirement that doesn't match any known cause — e.g., a client that can't support the
  dual-header (API key + webhook secret) model the REST API requires, where the legacy
  route's single-header model was accidentally load-bearing for a reason not caught during
  migration.
- **An urgent, unrelated need to reduce the REST API's blast radius** — e.g., a systemic
  API Gateway or REST-path-specific problem where having *any* working ingestion path
  matters more than which one.

A quiet retirement with no traffic anomalies afterward is not a trigger — don't restore it
preemptively "just in case."

#### Restoring it: exact steps

1. **Identify the retirement commit(s).** As of this writing, retirement has not yet
   happened, so there's no fixed commit hash to name here. When retirement happens, its
   commit message must say explicitly that it retires the legacy route (e.g., starting
   with `Retire legacy HTTP API POST /particle/log route`) specifically so this step stays
   mechanical:
   ```bash
   git log --oneline --grep='[Rr]etire legacy.*particle/log'
   ```
   If that turns up nothing, retirement wasn't done in one clearly-labeled commit — check
   `git log --oneline -- infra/lib/infra-stack.ts lambda/src/ingestion.ts` around the date
   this went to production and identify it by content instead (removal of the
   `httpApi.addRoutes({ path: '/particle/log', methods: [POST] })` block currently at
   `infra/lib/infra-stack.ts:558-566`, and of the legacy `else` branch currently at
   `lambda/src/ingestion.ts:69-85`).

2. **Check whether a plain revert is clean.** Before reverting, check whether anything else
   has touched the same two files since retirement:
   ```bash
   git log --oneline <retirement-commit>..HEAD -- infra/lib/infra-stack.ts lambda/src/ingestion.ts
   ```
   - **Empty output:** a plain `git revert <retirement-commit>` (or `git revert
     <commit1> <commit2>` if it was split across commits, oldest first) should apply
     cleanly.
   - **Non-empty output:** something else has changed these files since. Do not blindly
     revert — read what changed, then manually reintroduce the route
     (`infra/lib/infra-stack.ts:558-566`'s shape) and the legacy auth branch
     (`lambda/src/ingestion.ts:69-85`'s shape) into the *current* versions of these files
     by hand, so the restoration doesn't clobber unrelated work done after retirement.

3. **Build, test, diff, deploy** — same discipline as any other production infra change in
   this repo, not a shortcut because it's "just a revert":
   ```bash
   cd lambda && npm run build && npm test
   cd ../infra && npm run build && npm test
   npx cdk diff   # review in full before deploying -- confirm ONLY the /particle/log
                   # POST route and the legacy auth branch are being added back, nothing else
   npx cdk deploy
   ```

4. **Watch for the dynamic-reference gotcha encountered during migration**, even though
   this specific direction is a different case. During migration, CloudFormation failed to
   resolve a *newly-added* Secrets Manager JSON-key reference on a Lambda update
   (`Could not find a value associated with JSONKey in SecretString`) because the *old* key
   had been deleted from the secret while a prior deployed reference to it still existed.
   Restoring the route re-adds `ingestionFunction`'s reference to `QUERY_API_SHARED_SECRET`
   (an env var it stops reading once retired) — the key itself is never deleted from the
   secret (`query.ts` keeps needing it independently), so this exact failure mode likely
   doesn't reproduce. It hasn't been tested in this direction, though, so budget time for
   the possibility during the restore deploy. If it recurs, the same class of workaround
   applies: temporarily ensure whatever key the Lambda is being pointed at has been stable
   in the secret across the update (see the `PARTICLE_WEBHOOK_SECRET`-placeholder workaround
   used during the original migration for the exact mechanics).

#### What credential state it comes back in

**Same shared-secret auth as before — no code changes to the auth logic itself are
needed.** `QUERY_API_SHARED_SECRET` (the renamed `PARTICLE_WEBHOOK_SECRET`) stays live in
Secrets Manager for `query.ts`'s own use regardless of whether the legacy ingestion route
exists, so restoring `ingestion.ts`'s legacy `else` branch means it starts reading a secret
that's already there and already current — not a stale or rotated-away value. No secret
rotation or manual credential sync is required as part of restoring the route itself.

One thing this does **not** restore automatically: per-consumer visibility. The legacy
path has no concept of "which consumer" — it's a single shared-secret equality check, the
exact property this whole migration replaced. Restoring it reintroduces that blind spot for
whatever traffic uses it.

#### Who to notify and what to check afterward

- **If restored as a pure safety net** (trigger was an abundance of caution, nothing
  actually failed) — no consumer notification needed. Nothing should be pointed at the
  legacy URL; it exists only as a fallback. Confirm this stays true: check REST API and
  legacy HTTP API access logs after redeployment to verify traffic patterns are unchanged
  (still all on the REST API, nothing new on the legacy route).
- **If restored because a specific consumer was found still depending on it** — identify
  that consumer from the access logs that revealed it (source IP, `userAgent`, or which
  device/webhook stopped working), then:
  1. Notify whoever owns that integration (Particle Console webhook owner, or the Pi
     forwarder's operator — currently both are Chip) that a consumer was missed.
  2. Decide whether to leave it on the legacy route for now (since it's back) or do a
     proper migration for it (registry entry in `config/ingestion-consumers.json`, new
     Secrets Manager secret, new API key, same steps as every other consumer's migration).
  3. Re-run the full go/no-go checklist from `docs/security/webhook-secret-rotation-runbook.md`
     before attempting retirement again.

---

## Monitoring

### Key Metrics

**Lambda Metrics (CloudWatch):**
- `ConcurrentExecutions` — Burst traffic indicator
- `Duration` — Performance baseline
- `Errors` — Failure rate
- `Throttles` — Capacity issues

**API Gateway Metrics:**
- `5XXError` — Server errors
- `4XXError` — Client errors (auth failures)
- `Count` — Request volume

**S3 Metrics:**
- `PutRequests` — Storage throughput
- `4xxErrors` — Client errors

**DynamoDB Metrics:**
- `WriteThrottleEvents` — Capacity issues
- `SystemErrors` — Service errors

### Normal Baseline

**Traffic pattern:**
- ~500 devices per hour
- Burst at :00–:15 each hour
- Active 6:00am–10:00pm ET
- Minimal off-hour traffic

**Lambda performance:**
- Duration p50: <300ms (varies by network)
- Duration p99: <1000ms
- Concurrent executions: 50–200 during burst
- Errors: 0%

**Storage:**
- S3 writes: ~500/hour during active hours
- DynamoDB writes: ~500/hour during active hours
- No throttling

---

## Troubleshooting

### Lambda Errors

**401 Unauthorized (expected for invalid webhooks):**
- Check webhook secret configuration
- Verify header name case-sensitivity

**400 Invalid JSON:**
- Check webhook payload format
- Verify Content-Type header

**500 Internal Server Error:**
- Check CloudWatch logs for stack traces
- Verify S3 bucket permissions
- Verify DynamoDB table permissions
- Check AWS SDK connectivity

**Timeout errors:**
- Check S3 write latency
- Check DynamoDB write latency
- Verify network connectivity from Lambda

### Missing Events

**Device not reporting:**
1. Check device last seen in DynamoDB
2. Verify device webhook configuration
3. Check Particle Console event logs
4. Verify device connectivity

**Events dropped during burst:**
1. Check Lambda throttling metrics
2. Check DynamoDB write throttle events
3. Check API Gateway 5xx errors
4. Review CloudWatch logs for errors

### Performance Degradation

**Increased Lambda duration:**
1. Compare to baseline metrics
2. Check S3 write latency (CloudWatch Metrics)
3. Check DynamoDB write latency
4. Verify Lambda memory/CPU usage
5. Check for cold starts (InitDuration metric)

**Cold starts during burst:**
1. Check Lambda concurrent execution limit
2. Consider provisioned concurrency (requires AWS Agent review)
3. Verify deployment timing (avoid :00–:15 deploys)

---

## Inspection Tools

### Device Timeline Inspector

**Purpose:** Local read-only tool for querying device event timelines.

**Quick usage:**
```bash
cd scripts
npm install
npm run timeline -- --deviceId <deviceId> --hours 24
```

**Common scenarios:**

**Check recent device activity:**
```bash
npm run timeline -- --deviceId e00fce68e4fa8ab3f8faa207 --hours 24
```

**Investigate specific time window:**
```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --start 2026-06-26T14:00:00Z \
  --end 2026-06-26T15:00:00Z
```

**Inspect raw event data:**
```bash
npm run timeline -- \
  --deviceId e00fce68e4fa8ab3f8faa207 \
  --hours 24 \
  --show-raw
```

**See [tools.md](./tools.md) for comprehensive documentation.**

---

## Production Constraints

### Traffic Pattern

- ~500 devices report near top of each hour
- Hourly reporting pattern (not necessarily 500 concurrent invocations)
- Active reporting: 6:00am–10:00pm Eastern Time
- Off-peak: minimal traffic outside hourly windows

### Performance Requirements

- No added latency from Phase 1 refactor
- Sequential S3 → DynamoDB writes preserved
- No schema validation or rejection logic
- Burst tolerance maintained

### Deployment Constraints

- **Preferred window:** :30–:45 (bottom of hour)
- **Avoid window:** :00–:15 (top of hour burst)
- **Off-peak option:** After 10:00pm ET or before 6:00am ET
- **Validation required:** Immediate + next burst cycle

---

## Future Enhancements (Not in Phase 1)

The following are **NOT implemented** in Phase 1:
- Reserved/provisioned concurrency
- Lambda throttling configuration
- SQS queues or dead letter queues
- Custom CloudWatch dashboards
- Monitoring alarms
- Event normalization or enrichment
- Schema validation or rejection rules
- Canonical DynamoDB storage format

These may be considered after AWS Agent infrastructure review.
