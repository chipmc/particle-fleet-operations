# Lambda Development

## Directory Structure

```
lambda/
├── src/
│   ├── handler.ts           # Main Lambda entry point
│   ├── storage/
│   │   ├── s3.ts           # S3 raw event storage
│   │   └── dynamo.ts       # DynamoDB event indexing
│   ├── utils/
│   │   └── parse.ts        # Event parsing utilities
│   └── types/
│       └── index.ts        # TypeScript type definitions
├── tests/                   # Unit tests
├── package.json
├── tsconfig.json
└── jest.config.js
```

## Development Workflow

### Install Dependencies

```bash
cd lambda
npm install
```

### Build

```bash
npm run build
```

Output: `dist/` directory with compiled JavaScript

### Run Tests

```bash
npm test
```

Watch mode:
```bash
npm run test:watch
```

### Local Development

The Lambda is deployed via CDK. For local testing:

1. Run unit tests to verify logic
2. Use CDK local testing if needed
3. Deploy to AWS and test with real webhooks

## Testing

### Unit Tests

- `tests/handler.test.ts` - Handler integration tests
- `tests/storage/*.test.ts` - Storage module tests
- `tests/utils/*.test.ts` - Parser utility tests

Coverage threshold: 80% lines/functions, 70% branches

### Integration Testing

After deployment, test with:

```bash
curl -X POST https://<api-gateway-url>/particle/log \
  -H "Content-Type: application/json" \
  -H "X-Particle-Webhook-Secret: <secret>" \
  -d '{"event":"test","coreid":"device123","published_at":"2026-06-26T14:30:00.000Z"}'
```

Expected: `{"ok":true,"stored":true}`

## Architecture Notes

### Current Behavior (Phase 1)

This implementation preserves exact current behavior:

- Authentication via webhook secret header
- S3 immutable raw event storage
- DynamoDB fast indexed retrieval
- No normalization or validation

### Phase 2 Preparation

The codebase is structured for upcoming normalization:

- `utils/parse.ts` has scaffolded normalization functions
- `types/index.ts` has commented canonical event types
- Test scaffolding exists for future enrichment logic

See `docs/contracts/canonical-event-envelope.md` for canonical schema.

## Performance Considerations

### Production Traffic Pattern

- **Burst traffic:** ~500 devices at top of each hour
- **Reporting window:** 6:00am–10:00pm Eastern Time
- **Normal frequency:** Once per hour per device

### Optimization Notes

- Storage operations are async (non-blocking)
- No synchronous validation or transformation
- Lambda can handle concurrent invocations without serialization
- Test suite includes burst traffic simulation (500 concurrent requests)

## Deployment

Deployed via CDK from `infra/` directory.

CDK automatically compiles TypeScript and bundles Lambda code.

See `infra/README.md` for deployment instructions.

### Preferred Deployment Window

**Bottom of the hour** (e.g., 7:30am, 8:30am, 9:30am ET)

This minimizes risk of lost telemetry during top-of-hour reporting bursts.

### Post-Deploy Validation

1. **Immediate validation:**
   - Test webhook endpoint responds (200 OK)
   - Verify S3 raw event stored
   - Verify DynamoDB index created
   - Check CloudWatch logs for errors

2. **Next top-of-hour validation:**
   - Monitor CloudWatch metrics during burst
   - Verify all devices successfully ingested
   - Check for throttling or timeout errors
   - Confirm S3/DynamoDB write success rates

## Environment Variables

Required:

- `PARTICLE_WEBHOOK_SECRET` - Webhook authentication secret
- `RAW_LOGS_BUCKET_NAME` - S3 bucket for raw events
- `LOG_EVENTS_TABLE_NAME` - DynamoDB table for indexed events

Set by CDK during deployment.

## Troubleshooting

### Build Errors

- Verify TypeScript version: `5.5.x`
- Check `node_modules` installed: `npm install`
- Clear build cache: `rm -rf dist && npm run build`

### Test Failures

- Check AWS SDK mocks in test setup
- Verify environment variables in test config
- Run tests individually to isolate failures

### Runtime Errors

- Check CloudWatch logs: `/aws/lambda/<function-name>`
- Verify environment variables set correctly
- Test authentication with curl command above
- Verify S3/DynamoDB permissions granted by CDK
