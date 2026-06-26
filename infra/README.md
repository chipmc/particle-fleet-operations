# Infrastructure

AWS CDK infrastructure for Particle Log Monitoring

## Architecture

Deploys:
- API Gateway HTTP API
- Lambda function (TypeScript, modular)
- S3 bucket for raw event storage
- DynamoDB table for indexed event retrieval

## Lambda Source

Lambda code is in `../lambda/src/`

CDK uses `NodejsFunction` construct to:
- Automatically compile TypeScript
- Bundle dependencies with esbuild
- Deploy to Lambda

See `../lambda/README.md` for Lambda development.

## Deployment

### Prerequisites

```bash
npm install
```

### Preview Changes

```bash
cdk diff
```

Review changes carefully before deploying.

### Deploy

```bash
cdk deploy
```

**Preferred deployment window:** Bottom of the hour (e.g., 7:30am, 8:30am ET)

Reason: ~500 devices report at top of each hour. Deploying at bottom minimizes risk of lost telemetry.

### Post-Deploy Validation

**Immediate validation:**

```bash
# Test webhook endpoint
curl -X POST https://<api-gateway-url>/particle/log \
  -H "Content-Type: application/json" \
  -H "X-Particle-Webhook-Secret: <secret>" \
  -d '{"event":"test","coreid":"device123","published_at":"2026-06-26T14:30:00.000Z"}'

# Expected: {"ok":true,"stored":true}
```

**Top-of-hour validation:**

Monitor CloudWatch metrics during next top-of-hour reporting cycle:
- Lambda invocations (~500 expected)
- Error rate (should be near zero)
- Duration (should remain consistent)
- S3 PutObject success rate
- DynamoDB write success rate

## Production Traffic

- **Burst traffic:** ~500 devices at top of each hour
- **Reporting window:** 6:00am–10:00pm Eastern Time
- **Normal frequency:** Once per hour per device

## Rollback

If deployment fails:

```bash
cdk deploy --rollback
```

Or revert git commit and redeploy.

## Useful Commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
