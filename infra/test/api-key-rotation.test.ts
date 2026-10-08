/**
 * WO-2026-09-30-001 synthesis fixtures, as specified by the design's "Required
 * implementation verification" section: stable key slots across every rotation phase,
 * unchanged ingestion Lambda IAM, the scheduled checker's minimal permissions and failure
 * alarm, no deploy guard of any kind, and schema-v2 registry validation.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';
import { apiKeySlotName, loadIngestionConsumerRegistry } from '../lib/ingestion-consumers';
import * as lambdaSlots from '../../lambda/src/api-key-slots';
import { apiKeysPage, awsEnvFor, epochSeconds, startFakeAwsEndpoint } from '../../lambda/src/tests/helpers/fake-aws-endpoint';
import { resourcesReferencing } from './helpers/template-references';

/** Every resource that refers to the checker role, in any form, plus its literal name if one is set. */
function checkerRoleReferences(template: Template, roleId: string): string[] {
  const resources = template.toJSON().Resources as Record<string, { Properties?: { RoleName?: unknown } }>;
  const roleName = resources[roleId].Properties?.RoleName;
  return resourcesReferencing(resources, roleId, typeof roleName === 'string' ? [roleName] : []);
}

const BREAK_GLASS_PRINCIPAL_ARN = 'arn:aws:iam::123456789012:role/test-archive-operator';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-2026-09-30-001-'));

function consumer(id: string, apiKey: unknown, status = 'active'): Record<string, unknown> {
  return {
    id,
    displayName: id,
    secretName: `test/consumers/${id}/webhook-secret`,
    usagePlan: { ratePerSecond: 10, burst: 50 },
    status,
    apiKey,
  };
}

let registryCount = 0;
function writeRegistry(consumers: unknown[], schemaVersion = 2): string {
  const file = path.join(tmpDir, `registry-${registryCount++}.json`);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion, consumers }));
  return file;
}

// Stack id 'InfraStack' matches bin/infra.ts, so logical IDs here are the deployed ones.
function synth(registryPath?: string): Template {
  return Template.fromStack(new InfraStack(new cdk.App({
    context: { archiveOperatorPrincipalArn: BREAK_GLASS_PRINCIPAL_ARN },
  }), 'InfraStack', { ingestionConsumerRegistryPath: registryPath }));
}

const STEADY_A = { primarySlot: 'a' };
const STEADY_B = { primarySlot: 'b' };
const OVERLAP_A_TO_B = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap' } };
const DISABLED_A_TO_B = { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'old-disabled' } };
const OVERLAP_B_TO_A = { primarySlot: 'b', rotation: { secondarySlot: 'a', phase: 'overlap' } };

function phase(alphaApiKey: unknown, betaApiKey: unknown = STEADY_A): Template {
  return synth(writeRegistry([consumer('alpha', alphaApiKey), consumer('beta', betaApiKey)]));
}

type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;

function ofType(t: Template, type: string): Resources {
  return t.findResources(type) as Resources;
}

function alphaKeyResources(t: Template): Resources {
  const out: Resources = {};
  for (const type of ['AWS::ApiGateway::ApiKey', 'AWS::ApiGateway::UsagePlanKey', 'AWS::ApiGateway::UsagePlan']) {
    for (const [id, r] of Object.entries(ofType(t, type))) if (id.startsWith('IngestionConsumerAlpha')) out[id] = r;
  }
  return out;
}

function ingestionEnv(t: Template): Record<string, unknown> {
  const fns = Object.entries(ofType(t, 'AWS::Lambda::Function'))
    .filter(([id]) => id.startsWith('ParticleLogIngestionFunction'));
  expect(fns).toHaveLength(1);
  return (fns[0][1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
}

function ingestionPolicies(t: Template): unknown {
  return Object.entries(ofType(t, 'AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith('ParticleLogIngestionFunction'))
    .map(([id, r]) => [id, r]);
}

const ALPHA_A_KEY = 'IngestionConsumerAlphaApiKey';
const ALPHA_B_KEY = 'IngestionConsumerAlphaApiKeyB';
const keyIdOf = (t: Template, prefix: string) =>
  Object.keys(ofType(t, 'AWS::ApiGateway::ApiKey')).filter(id => id.startsWith(prefix) && /^[0-9A-F]{8}$/.test(id.slice(prefix.length)));
const associationsFor = (t: Template, keyLogicalId: string) =>
  Object.keys(ofType(t, 'AWS::ApiGateway::UsagePlanKey')).filter(id =>
    JSON.stringify(ofType(t, 'AWS::ApiGateway::UsagePlanKey')[id].Properties.KeyId) === JSON.stringify({ Ref: keyLogicalId }));

describe('mechanism rollout on the checked-in registry replaces nothing', () => {
  test('slot a keeps the exact logical IDs recorded from a pre-change synth of main (a15734b)', () => {
    // Recorded independently, before any change, from `cdk synth` on main. Not derived here.
    // A steady-state fact: synthesize the checked-in consumers with no rotation, whatever state
    // the checked-in file is in during a live rotation.
    const checkedIn = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/ingestion-consumers.json'), 'utf8'));
    const t = synth(writeRegistry(checkedIn.consumers.map((c: object) => ({ ...c, apiKey: STEADY_A })), checkedIn.schemaVersion));
    const keys = ofType(t, 'AWS::ApiGateway::ApiKey');
    expect(Object.keys(keys).sort()).toEqual([
      'IngestionConsumerParticleCloudWebhookApiKeyA4BA5483',
      'IngestionConsumerSerialForwarderApiKey5E71B252',
    ]);
    expect(keys.IngestionConsumerParticleCloudWebhookApiKeyA4BA5483.Properties).toEqual({
      Description: 'API key for ingestion consumer: Particle Cloud webhook (particle-cloud-webhook)',
      Enabled: true,
      Name: 'particle-ingestion-particle-cloud-webhook',
    });
    expect(Object.keys(ofType(t, 'AWS::ApiGateway::UsagePlanKey')).sort()).toEqual([
      'IngestionConsumerParticleCloudWebhookUsagePlanUsagePlanKeyResourceInfraStackIngestionConsumerParticleCloudWebhookApiKey0B37742576D39CBB',
      'IngestionConsumerSerialForwarderUsagePlanUsagePlanKeyResourceInfraStackIngestionConsumerSerialForwarderApiKey01F396C5120CA4E3',
    ]);
    expect(Object.keys(ofType(t, 'AWS::ApiGateway::UsagePlan')).sort()).toEqual([
      'IngestionConsumerParticleCloudWebhookUsagePlanCE54FCA8',
      'IngestionConsumerSerialForwarderUsagePlanCDAFEF4A',
    ]);
    const env = ingestionEnv(t);
    expect(Object.keys(env).filter(k => k.startsWith('INGESTION_API_KEY')).sort()).toEqual([
      'INGESTION_API_KEY_ID_PARTICLE_CLOUD_WEBHOOK',
      'INGESTION_API_KEY_ID_SERIAL_FORWARDER',
    ]);
  });
});

describe('rotation phases keep stable slots', () => {
  const baseline = phase(STEADY_A);
  const overlap = phase(OVERLAP_A_TO_B);
  const disabled = phase(DISABLED_A_TO_B);
  const cleanup = phase(STEADY_B);
  const reverse = phase(OVERLAP_B_TO_A);
  const all = { baseline, overlap, disabled, cleanup, reverse };

  test('baseline: alpha has only slot a, under the pre-slot construct ID', () => {
    expect(keyIdOf(baseline, ALPHA_A_KEY)).toHaveLength(1);
    expect(keyIdOf(baseline, ALPHA_B_KEY)).toHaveLength(0);
    expect(ingestionEnv(baseline)).not.toHaveProperty('INGESTION_API_KEY_ROTATION_ID_ALPHA');
  });

  test('overlap adds exactly one key and one association; slot a resources are untouched', () => {
    const before = alphaKeyResources(baseline);
    const after = alphaKeyResources(overlap);
    const added = Object.keys(after).filter(id => !(id in before));
    expect(added.map(id => after[id].Type).sort()).toEqual(['AWS::ApiGateway::ApiKey', 'AWS::ApiGateway::UsagePlanKey']);
    for (const id of Object.keys(before)) expect(after[id]).toEqual(before[id]);
    const [bKey] = keyIdOf(overlap, ALPHA_B_KEY);
    expect(after[bKey].Properties).toMatchObject({ Name: 'particle-ingestion-alpha-b', Enabled: true });
    const env = ingestionEnv(overlap);
    expect(env.INGESTION_API_KEY_ID_ALPHA).toEqual({ Ref: keyIdOf(overlap, ALPHA_A_KEY)[0] });
    expect(env.INGESTION_API_KEY_ROTATION_ID_ALPHA).toEqual({ Ref: bKey });
  });

  test('old-disabled changes only the old key\'s Enabled flag among key resources; both keys and IDs remain', () => {
    const before = alphaKeyResources(overlap);
    const after = alphaKeyResources(disabled);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const [aKey] = keyIdOf(disabled, ALPHA_A_KEY);
    for (const id of Object.keys(before)) {
      if (id === aKey) expect(after[id].Properties).toEqual({ ...before[id].Properties, Enabled: false });
      else expect(after[id]).toEqual(before[id]);
    }
    expect(ingestionEnv(disabled).INGESTION_API_KEY_ID_ALPHA).toEqual(ingestionEnv(overlap).INGESTION_API_KEY_ID_ALPHA);
    expect(ingestionEnv(disabled).INGESTION_API_KEY_ROTATION_ID_ALPHA).toEqual(ingestionEnv(overlap).INGESTION_API_KEY_ROTATION_ID_ALPHA);
  });

  test('cleanup retains slot b (key and association unchanged) and deletes only slot a\'s key and association', () => {
    const before = alphaKeyResources(disabled);
    const after = alphaKeyResources(cleanup);
    const [aKey] = keyIdOf(disabled, ALPHA_A_KEY);
    const [bKey] = keyIdOf(disabled, ALPHA_B_KEY);
    const removed = Object.keys(before).filter(id => !(id in after)).sort();
    expect(removed).toEqual([aKey, ...associationsFor(disabled, aKey)].sort());
    expect(Object.keys(after).filter(id => !(id in before))).toEqual([]);
    for (const id of Object.keys(after)) expect(after[id]).toEqual(before[id]);
    expect(associationsFor(cleanup, bKey)).toEqual(associationsFor(disabled, bKey));
    const env = ingestionEnv(cleanup);
    expect(env.INGESTION_API_KEY_ID_ALPHA).toEqual({ Ref: bKey });
    expect(env).not.toHaveProperty('INGESTION_API_KEY_ROTATION_ID_ALPHA');
  });

  test('a reverse rotation recreates slot a without replacing slot b', () => {
    const before = alphaKeyResources(cleanup);
    const after = alphaKeyResources(reverse);
    for (const id of Object.keys(before)) expect(after[id]).toEqual(before[id]);
    const added = Object.keys(after).filter(id => !(id in before));
    expect(added.map(id => after[id].Type).sort()).toEqual(['AWS::ApiGateway::ApiKey', 'AWS::ApiGateway::UsagePlanKey']);
    // Same construct ID as the original slot a (a new physical key, since that one was deleted).
    expect(keyIdOf(reverse, ALPHA_A_KEY)).toEqual(keyIdOf(baseline, ALPHA_A_KEY));
    const env = ingestionEnv(reverse);
    expect(env.INGESTION_API_KEY_ID_ALPHA).toEqual({ Ref: keyIdOf(reverse, ALPHA_B_KEY)[0] });
    expect(env.INGESTION_API_KEY_ROTATION_ID_ALPHA).toEqual({ Ref: keyIdOf(reverse, ALPHA_A_KEY)[0] });
  });

  test('beta\'s key resources are identical in every alpha phase', () => {
    const beta = (t: Template) => Object.fromEntries(Object.entries({
      ...ofType(t, 'AWS::ApiGateway::ApiKey'), ...ofType(t, 'AWS::ApiGateway::UsagePlanKey'), ...ofType(t, 'AWS::ApiGateway::UsagePlan'),
    }).filter(([id]) => id.startsWith('IngestionConsumerBeta')));
    for (const t of Object.values(all)) expect(beta(t)).toEqual(beta(baseline));
  });

  test('ingestion Lambda IAM policies are identical across the mechanism and every rotation phase', () => {
    for (const t of Object.values(all)) expect(ingestionPolicies(t)).toEqual(ingestionPolicies(baseline));
  });

  test('no SSM rotation parameter, registrar, or other custom resource is synthesized in any phase', () => {
    for (const t of Object.values(all)) {
      expect(Object.keys(ofType(t, 'AWS::SSM::Parameter'))).toEqual([]);
      const types = new Set(Object.values(t.toJSON().Resources as Resources).map(r => r.Type));
      const custom = [...types].filter(type => type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource');
      expect(custom).toEqual(['Custom::LogRetention']);
    }
  });
});

describe('no deploy is ever blocked by a stale rotation', () => {
  afterEach(() => jest.useRealTimers());

  test('synth succeeds for every shape of deploy while alpha is long overdue, and never reads the clock', () => {
    // Far past any alert target. Synth checks registry shape, not age.
    // Fake only the clock. Each set*/clear* pair stays real together: faking clear* alone left
    // clearTimeout/clearInterval/clearImmediate undefined after useRealTimers, hanging later SDK calls.
    jest.useFakeTimers({ now: new Date('2031-01-01T00:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
    const deploys: [string, unknown, unknown][] = [
      ['unrelated stack fix / shared Lambda asset change with alpha overdue in overlap', OVERLAP_A_TO_B, STEADY_A],
      ['beta rotation while alpha is overdue', OVERLAP_A_TO_B, OVERLAP_A_TO_B],
      ['reviewed disable', DISABLED_A_TO_B, STEADY_A],
      ['reviewed rollback to overlap', OVERLAP_A_TO_B, STEADY_A],
      ['deploy 3 cleanup', STEADY_B, STEADY_A],
    ];
    for (const [, alpha, beta] of deploys) {
      const t = phase(alpha, beta);
      // No deploy gate: no change-set hook, no wait condition, no rule that fails a deploy.
      expect(Object.keys(ofType(t, 'AWS::CloudFormation::WaitCondition'))).toEqual([]);
      expect(Object.keys(ofType(t, 'AWS::CloudFormation::Macro'))).toEqual([]);
      // CDK's standard bootstrap-version assertion is the only template Rule, as before this change.
      expect(Object.keys(t.toJSON().Rules ?? {})).toEqual(['CheckBootstrapVersion']);
      expect(t.toJSON().Hooks).toBeUndefined();
    }
  });

  test('deploys stay plain `cdk deploy`: no wrapper script or deploy override in the CDK app config', () => {
    const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
    expect(cdkJson.app).toBe('npx ts-node --prefer-ts-exts bin/infra.ts');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(Object.keys(pkg.scripts).sort()).toEqual(['build', 'cdk', 'test', 'watch']);
  });
});

describe('daily rotation checker', () => {
  const t = synth();
  const checkerRolePolicies = () => Object.entries(ofType(t, 'AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith('IngestionApiKeyRotationCheckerFunction'));

  test('runs on an EventBridge schedule at 09:00 UTC', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 9 * * ? *)',
      State: 'ENABLED',
      Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^IngestionApiKeyRotationCheckerFunction'), 'Arn'] } })],
    });
  });

  test('publishes to its own topic, emailed to Chip, not the monthly-archive topic', () => {
    t.hasResourceProperties('AWS::SNS::Topic', { DisplayName: 'Particle ingestion API key rotation' });
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'chip@seeinsights.com',
      TopicArn: { Ref: Match.stringLikeRegexp('^IngestionApiKeyRotationNotifications') },
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ROTATION_ALERT_TOPIC_ARN: { Ref: Match.stringLikeRegexp('^IngestionApiKeyRotationNotifications') } } },
    });
  });

  test('its role is exactly read-only API key metadata plus publish to its own topic', () => {
    const policies = checkerRolePolicies();
    expect(policies).toHaveLength(1);
    const apikeysArn = (suffix: string) => ({
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':apigateway:', { Ref: 'AWS::Region' }, `::/apikeys${suffix}`]],
    });
    expect((policies[0][1].Properties.PolicyDocument as { Statement: unknown[] }).Statement).toEqual([
      { Action: 'sns:Publish', Effect: 'Allow', Resource: { Ref: expect.stringMatching(/^IngestionApiKeyRotationNotifications/) } },
      { Action: 'apigateway:GET', Effect: 'Allow', Resource: apikeysArn('') },
    ]);
    const serialized = JSON.stringify(policies);
    // GetApiKey (/apikeys/{id}) is not needed: GetApiKeys returns every field the checker uses.
    expect(serialized).not.toContain('/apikeys/');
    // GetUsagePlanKeys returns key values; the checker must have no route to it.
    expect(serialized).not.toContain('usageplans');
    expect(serialized).not.toMatch(/apigateway:(POST|PUT|PATCH|DELETE|\*)/);
  });

  test('a checker failure alarms to the rotation topic, and Lambda does not retry (no duplicate alerts)', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: Match.stringLikeRegexp('^IngestionApiKeyRotationCheckerFunction') } }],
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^IngestionApiKeyRotationNotifications') }],
    });
    t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: Match.stringLikeRegexp('^IngestionApiKeyRotationCheckerFunction') },
      MaximumRetryAttempts: 0,
    });
  });
});

describe('daily rotation checker: deployed entry point and complete permission surface', () => {
  // Synthesized through a real cloud assembly so the bundled asset itself can be executed.
  const app = new cdk.App({ context: { archiveOperatorPrincipalArn: BREAK_GLASS_PRINCIPAL_ARN } });
  new InfraStack(app, 'InfraStack');
  const assembly = app.synth();
  const t = Template.fromJSON(assembly.getStackByName('InfraStack').template);
  const [checkerId, checker] = Object.entries(ofType(t, 'AWS::Lambda::Function'))
    .find(([id]) => id.startsWith('IngestionApiKeyRotationCheckerFunction'))!;
  const roleId = (checker.Properties.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
  const registered = loadIngestionConsumerRegistry(path.join(__dirname, '../../config/ingestion-consumers.json')).map(c => c.id);

  test('the deployed function is the checker: exact runtime and handler, and the configured export runs the check', async () => {
    expect(checker.Properties.Runtime).toBe('nodejs22.x');
    expect(checker.Properties.Handler).toBe('index.handler');
    const [file, exportName] = (checker.Properties.Handler as string).split('.');
    const s3Key = (checker.Properties.Code as { S3Key: string }).S3Key;
    const bundle = path.join(assembly.directory, `asset.${s3Key.replace(/\.zip$/, '')}`, `${file}.js`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const configured = (require(bundle) as Record<string, unknown>)[exportName] as () => Promise<void>;
    expect(typeof configured).toBe('function');

    // Execute it against a local fake API Gateway/SNS, with the production registry the
    // bundle carries: every registered consumer gets only a key whose name matches neither of
    // its slots, so in any rotation state each must produce its own no_keys inconsistency.
    const endpoint = await startFakeAwsEndpoint();
    const originalEnv = process.env;
    const topic = 'arn:aws:sns:us-east-1:123456789012:entry-point-test';
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    let limit: NodeJS.Timeout | undefined;
    try {
      process.env = { ...awsEnvFor(endpoint.url), ROTATION_ALERT_TOPIC_ARN: topic };
      endpoint.getApiKeys = () => apiKeysPage(registered.map((id, i) => ({
        id: `key${i}`, name: `particle-ingestion-${id}-retired`, enabled: true, createdDate: epochSeconds('2026-09-01T00:00:00Z'), value: 'must-not-cross',
      })));
      // A hang fails here, inside the try, well before Jest's own timeout, so the finally always runs.
      await Promise.race([configured(), new Promise<never>((_, reject) => {
        limit = setTimeout(() => reject(new Error('checker did not finish within 10 s')), 10_000);
      })]);
      expect(endpoint.requests.filter(r => r.path === '/apikeys').map(r => r.query)).toEqual([{ includeValues: 'false', limit: '500' }]);
      const published = endpoint.requests.filter(r => r.form.Action === 'Publish');
      expect(published.map(r => r.form.TopicArn)).toEqual(registered.map(() => topic));
      expect(published.map(r => JSON.parse(r.form.Message))).toEqual(registered.map((id, i) => ({
        event: 'ingestion_api_key_rotation_inconsistency', consumerId: id, reason: 'no_keys', keyCount: 0,
        keys: [],
      })));
      expect(JSON.stringify([endpoint.requests, info.mock.calls])).not.toContain('must-not-cross');
    } finally {
      clearTimeout(limit);
      process.env = originalEnv;
      info.mockRestore();
      await endpoint.close();
    }
  }, 20_000);

  test('the whole template references the checker role only from the checker function and its one exact policy', () => {
    const role = ofType(t, 'AWS::IAM::Role')[roleId];
    expect(role.Properties.ManagedPolicyArns).toEqual([{
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']],
    }]);
    expect(role.Properties.Policies).toBeUndefined();
    expect(role.Properties.PermissionsBoundary).toBeUndefined();
    // Any reference form -- Ref, Fn::GetAtt (array or dotted string), Fn::Sub (${Id} or
    // ${Id.Arn}), DependsOn, or a literal role name if one is ever set -- including the role as
    // a principal in some other resource's policy.
    const [policyId, policy] = Object.entries(ofType(t, 'AWS::IAM::Policy')).find(([, r]) => JSON.stringify(r).includes(`"${roleId}"`))!;
    expect(checkerRoleReferences(t, roleId)).toEqual([policyId, checkerId].sort());
    expect(policy.Properties.Roles).toEqual([{ Ref: roleId }]);
    expect((policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement).toEqual([
      { Action: 'sns:Publish', Effect: 'Allow', Resource: { Ref: expect.stringMatching(/^IngestionApiKeyRotationNotifications/) } },
      { Action: 'apigateway:GET', Effect: 'Allow', Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':apigateway:', { Ref: 'AWS::Region' }, '::/apikeys']] } },
    ]);
  });

  test('negative control: IAM does not, and cannot, stop this role requesting key values', () => {
    // GET /apikeys serves both includeValues=false and includeValues=true, and API Gateway
    // has no IAM condition key for that parameter. This test documents the limitation so
    // it is never mistaken for an IAM guarantee: value safety rests on the metadata adapter
    // (lambda/src/rotation-checker/metadata-adapter.ts), its boundary tests, and review.
    const [, policy] = Object.entries(ofType(t, 'AWS::IAM::Policy')).find(([, r]) => JSON.stringify(r).includes(`"${roleId}"`))!;
    const apiGatewayStatements = (policy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement
      .filter(statement => statement.Action === 'apigateway:GET');
    expect(apiGatewayStatements).toHaveLength(1);
    expect(apiGatewayStatements[0].Condition).toBeUndefined();
    expect(JSON.stringify(apiGatewayStatements[0].Resource)).toContain('::/apikeys');
  });

  test('fixture: the role scan catches a grant that names the role only through Fn::Sub (Codex round-3 survivor I07)', () => {
    const mutatedApp = new cdk.App({ context: { archiveOperatorPrincipalArn: BREAK_GLASS_PRINCIPAL_ARN } });
    const stack = new InfraStack(mutatedApp, 'InfraStack');
    const checkerFn = stack.node.findChild('IngestionApiKeyRotationCheckerFunction') as cdk.aws_lambda.Function;
    const checkerRoleId = stack.getLogicalId(checkerFn.role!.node.defaultChild as cdk.CfnElement);
    const topic = stack.node.findChild('IngestionApiKeyRotationNotifications') as cdk.aws_sns.Topic;
    new cdk.aws_sns.CfnTopicPolicy(stack, 'SubGrant', {
      topics: [topic.topicArn],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'sns:*', Resource: '*', Principal: { AWS: { 'Fn::Sub': `\${${checkerRoleId}.Arn}` } } }],
      },
    });
    const mutated = Template.fromStack(stack);
    // The grant names the role only inside a Fn::Sub string, which the old quoted-ID search missed.
    const subGrant = (mutated.toJSON().Resources as Record<string, unknown>).SubGrant;
    expect(JSON.stringify(subGrant)).not.toContain(`"${checkerRoleId}"`);
    expect(checkerRoleReferences(mutated, checkerRoleId)).toContain('SubGrant');
  });
});

describe('rotation deploys publish a new version of the shared function and move prod to it', () => {
  const versionOf = (t: Template) => {
    const fnId = Object.keys(ofType(t, 'AWS::Lambda::Function')).find(id => id.startsWith('ParticleLogIngestionFunction'))!;
    const versions = Object.entries(ofType(t, 'AWS::Lambda::Version')).filter(([, r]) => JSON.stringify(r.Properties.FunctionName) === JSON.stringify({ Ref: fnId }));
    expect(versions).toHaveLength(1);
    const [, alias] = Object.entries(ofType(t, 'AWS::Lambda::Alias')).find(([, r]) => r.Properties.Name === 'prod')!;
    expect(alias.Properties.FunctionVersion).toEqual({ 'Fn::GetAtt': [versions[0][0], 'Version'] });
    return versions[0][0];
  };
  const steady = versionOf(phase(STEADY_A));

  test('each rotation phase (an environment change) publishes its own version', () => {
    const ids = [steady, versionOf(phase(OVERLAP_A_TO_B)), versionOf(phase(STEADY_B)), versionOf(phase(OVERLAP_B_TO_A))];
    expect(new Set(ids).size).toBe(4);
  });

  test('a change that does not touch the shared function does not churn its version', () => {
    const throttleOnly = synth(writeRegistry([
      { ...consumer('alpha', STEADY_A), usagePlan: { ratePerSecond: 77, burst: 99 } },
      consumer('beta', STEADY_A),
    ]));
    expect(versionOf(throttleOnly)).toBe(steady);
  });
});

describe('infra and Lambda agree on the slot naming convention', () => {
  test('key names and environment variable names match the Lambda\'s helpers', () => {
    for (const id of ['alpha', 'alpha-long', 'particle-cloud-webhook']) {
      for (const slot of ['a', 'b'] as const) expect(apiKeySlotName(id, slot)).toBe(lambdaSlots.apiKeySlotName(id, slot));
    }
    const t = phase(OVERLAP_A_TO_B);
    const names = Object.values(ofType(t, 'AWS::ApiGateway::ApiKey')).map(r => r.Properties.Name).sort();
    expect(names).toEqual(['particle-ingestion-alpha', 'particle-ingestion-alpha-b', 'particle-ingestion-beta']);
    const env = ingestionEnv(t);
    expect(env).toHaveProperty(lambdaSlots.primaryKeyIdEnvVar('alpha'));
    expect(env).toHaveProperty(lambdaSlots.rotationKeyIdEnvVar('alpha'));
    expect(env).toHaveProperty(lambdaSlots.primaryKeyIdEnvVar('beta'));
  });
});

describe('registry schema version 2 validation', () => {
  const load = (consumers: unknown[], schemaVersion = 2) => () => loadIngestionConsumerRegistry(writeRegistry(consumers, schemaVersion));

  test('the checked-in registry is valid in whatever rotation state it is in, by the Lambda\'s own check too', () => {
    // Which slots and phases are allowed is covered by the fixtures in this file, not by the live file.
    const real = loadIngestionConsumerRegistry(path.join(__dirname, '../../config/ingestion-consumers.json'));
    expect(real.map(c => lambdaSlots.apiKeyConfigProblem(c.apiKey))).toEqual(real.map(() => undefined));
  });

  test('schema version 1 is rejected', () => {
    expect(load([consumer('alpha', STEADY_A)], 1)).toThrow('unsupported schemaVersion 1 (expected 2)');
  });

  test.each([
    ['missing apiKey', undefined, 'is missing apiKey'],
    ['invalid primarySlot', { primarySlot: 'c' }, 'invalid apiKey.primarySlot'],
    ['secondary equals primary', { primarySlot: 'a', rotation: { secondarySlot: 'a', phase: 'overlap' } }, 'must differ from primarySlot'],
    ['invalid secondarySlot', { primarySlot: 'a', rotation: { secondarySlot: 'x', phase: 'overlap' } }, 'invalid apiKey.rotation.secondarySlot'],
    ['invalid phase', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'done' } }, 'invalid apiKey.rotation.phase'],
    ['timestamp in rotation', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap', startedAt: '2026-09-21T00:00:00Z' } }, 'unsupported field "startedAt"'],
    ['deadline in rotation', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap', expiresAt: '2026-09-28T00:00:00Z' } }, 'unsupported field "expiresAt"'],
    ['key ID in apiKey', { primarySlot: 'a', keyId: 'abc123' }, 'unsupported field "keyId"'],
  ])('%s is rejected at synth', (_label, apiKey, message) => {
    expect(load([consumer('alpha', apiKey)])).toThrow(message);
  });

  test('a rotation on an inactive consumer is rejected', () => {
    expect(load([consumer('alpha', OVERLAP_A_TO_B, 'inactive')])).toThrow('declares an apiKey.rotation but is not active');
  });

  test('an overdue rotation is not rejected merely because time has passed (no age check)', () => {
    expect(load([consumer('alpha', DISABLED_A_TO_B)])).not.toThrow();
  });

  test('alpha and alpha-b collide on a generated slot name and are rejected, in either order and either rotation state', () => {
    for (const consumers of [
      [consumer('alpha', STEADY_A), consumer('alpha-b', STEADY_A)],
      [consumer('alpha-b', STEADY_A), consumer('alpha', STEADY_A)],
      [consumer('alpha', OVERLAP_A_TO_B), consumer('alpha-b', STEADY_B)],
    ]) {
      expect(load(consumers)).toThrow('API key name "particle-ingestion-alpha-b" is generated for both consumer');
    }
  });

  test('alpha and alpha-long do not collide', () => {
    expect(load([consumer('alpha', STEADY_A), consumer('alpha-long', STEADY_A)])).not.toThrow();
  });
});
