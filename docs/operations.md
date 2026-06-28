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
