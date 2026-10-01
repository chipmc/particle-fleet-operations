/**
 * WO-2026-09-30-001 design, Revision 4: alias foundation fixtures. Every production API
 * integration for the shared ingestion/query function invokes one stable `prod` alias over
 * a published, retained version -- never the unqualified function or `$LATEST` -- so a
 * request can't observe new code with old environment (or the reverse) mid-update.
 * Assertions read the synthesized template, not construct intent.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';

const BREAK_GLASS_PRINCIPAL_ARN = 'arn:aws:iam::123456789012:role/test-archive-operator';

type Resource = { Type: string; Properties?: Record<string, unknown>; DependsOn?: string | string[]; DeletionPolicy?: string; UpdateReplacePolicy?: string };

function synthResources(context: Record<string, unknown> = {}): Record<string, Resource> {
  const app = new cdk.App({ context: { archiveOperatorPrincipalArn: BREAK_GLASS_PRINCIPAL_ARN, ...context } });
  return Template.fromStack(new InfraStack(app, 'InfraStack')).toJSON().Resources as Record<string, Resource>;
}

const resources = synthResources();
const entries = Object.entries(resources);
const ofType = (type: string) => entries.filter(([, r]) => r.Type === type);
const [functionId] = ofType('AWS::Lambda::Function').find(([id]) => id.startsWith('ParticleLogIngestionFunction'))!;
const versions = ofType('AWS::Lambda::Version').filter(([, r]) => JSON.stringify(r.Properties?.FunctionName) === JSON.stringify({ Ref: functionId }));
const aliases = ofType('AWS::Lambda::Alias').filter(([, r]) => JSON.stringify(r.Properties?.FunctionName) === JSON.stringify({ Ref: functionId }));
const dependsOn = (r: Resource) => (Array.isArray(r.DependsOn) ? r.DependsOn : r.DependsOn ? [r.DependsOn] : []);

describe('published version and stable prod alias', () => {
  test('exactly one version of the shared function, retained on update and replacement', () => {
    expect(versions).toHaveLength(1);
    expect(versions[0][1].DeletionPolicy).toBe('Retain');
    expect(versions[0][1].UpdateReplacePolicy).toBe('Retain');
  });

  test('exactly one alias, named prod, pointing at that version', () => {
    expect(aliases).toHaveLength(1);
    expect(aliases[0][1].Properties).toEqual({
      FunctionName: { Ref: functionId },
      FunctionVersion: { 'Fn::GetAtt': [versions[0][0], 'Version'] },
      Name: 'prod',
    });
  });
});

describe('every production trigger invokes the alias', () => {
  const [aliasId] = aliases[0];

  test('all seven HTTP API integrations target the qualified alias ARN', () => {
    const integrations = ofType('AWS::ApiGatewayV2::Integration');
    expect(integrations).toHaveLength(7);
    for (const [, r] of integrations) {
      expect(r.Properties?.IntegrationType).toBe('AWS_PROXY');
      expect(r.Properties?.IntegrationUri).toEqual({ Ref: aliasId });
    }
  });

  test('the REST ingestion method targets the qualified alias ARN', () => {
    const methods = ofType('AWS::ApiGateway::Method');
    expect(methods).toHaveLength(1);
    const uri = JSON.stringify((methods[0][1].Properties?.Integration as { Uri: unknown }).Uri);
    expect(uri).toContain(JSON.stringify({ Ref: aliasId }));
    expect(uri).not.toContain(functionId);
  });

  test('nothing references the unqualified function except its version, alias, and log retention', () => {
    // `$LATEST` would be reached through the function's own Ref/Arn; an event source,
    // rule target, integration or permission naming it would bypass the alias.
    const referencing = entries
      .filter(([id]) => id !== functionId)
      .filter(([, r]) => JSON.stringify(r).includes(`"${functionId}"`))
      .map(([id, r]) => `${r.Type} ${id}`);
    expect(referencing.map(s => s.split(' ')[0]).sort()).toEqual(['AWS::Lambda::Alias', 'AWS::Lambda::Version', 'Custom::LogRetention']);
    expect(ofType('AWS::Lambda::EventSourceMapping')).toEqual([]);
  });

  test('every API Gateway invoke permission is on the alias, never the bare function', () => {
    const apigwPermissions = ofType('AWS::Lambda::Permission').filter(([, r]) => r.Properties?.Principal === 'apigateway.amazonaws.com');
    // 7 HTTP routes + 2 REST (stage and test-invoke) per-route permissions + 2 API-wide.
    expect(apigwPermissions).toHaveLength(11);
    for (const [, r] of apigwPermissions) expect(r.Properties?.FunctionName).toEqual({ Ref: aliasId });
  });
});

describe('no integration can go live before the alias can be invoked', () => {
  const [aliasId] = aliases[0];
  const [httpPermissionId, httpPermission] = entries.find(([id]) => id.startsWith(`${aliasId.replace(/[0-9A-F]{8}$/, '')}HttpApiInvoke`))!;
  const [restPermissionId, restPermission] = entries.find(([id]) => id.startsWith(`${aliasId.replace(/[0-9A-F]{8}$/, '')}RestApiInvoke`))!;
  const [httpApiId] = ofType('AWS::ApiGatewayV2::Api')[0];
  const [restApiId] = ofType('AWS::ApiGateway::RestApi')[0];

  test('API-wide alias permissions are scoped to their own API and reference no stage or deployment', () => {
    // execute-api ARN: {apiId}/{stage}/{method}/{path}, wildcarded within one API.
    const execArn = (apiId: string, suffix: string) => ({
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':execute-api:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':', { Ref: apiId }, suffix]],
    });
    expect(httpPermission.Properties).toEqual({
      Action: 'lambda:InvokeFunction',
      FunctionName: { Ref: aliasId },
      Principal: 'apigateway.amazonaws.com',
      SourceArn: execArn(httpApiId, '/*/*/*'),
    });
    expect(restPermission.Properties).toEqual({
      Action: 'lambda:InvokeFunction',
      FunctionName: { Ref: aliasId },
      Principal: 'apigateway.amazonaws.com',
      SourceArn: execArn(restApiId, '/*/*/*'),
    });
  });

  test('every HTTP integration and the auto-deploying default stage depend on the HTTP alias permission', () => {
    for (const [, r] of ofType('AWS::ApiGatewayV2::Integration')) expect(dependsOn(r)).toContain(httpPermissionId);
    const [, stage] = ofType('AWS::ApiGatewayV2::Stage')[0];
    expect(dependsOn(stage)).toContain(httpPermissionId);
  });

  test('the REST deployment that switches the method to the alias depends on the REST alias permission', () => {
    const deployments = ofType('AWS::ApiGateway::Deployment');
    expect(deployments).toHaveLength(1);
    expect(dependsOn(deployments[0][1])).toContain(restPermissionId);
  });
});

describe('new versions are published exactly when the function changes', () => {
  // The CDK `currentVersion` contract this design relies on, checked against the installed
  // aws-cdk-lib on a minimal function: code or configuration changes publish a new version;
  // a change elsewhere in the stack does not churn it.
  function versionId(code: string, env: Record<string, string>, unrelatedBucket: boolean): string {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'VersionProbe');
    const fn = new lambda.Function(stack, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(code),
      environment: env,
    });
    new lambda.Alias(stack, 'Prod', { aliasName: 'prod', version: fn.currentVersion });
    if (unrelatedBucket) new cdk.aws_s3.Bucket(stack, 'Unrelated');
    const ids = Object.entries(Template.fromStack(stack).toJSON().Resources as Record<string, Resource>)
      .filter(([, r]) => r.Type === 'AWS::Lambda::Version').map(([id]) => id);
    expect(ids).toHaveLength(1);
    return ids[0];
  }
  const base = versionId('exports.handler = async () => 1;', { A: '1' }, false);

  test('code-only change publishes a new version', () => {
    expect(versionId('exports.handler = async () => 2;', { A: '1' }, false)).not.toBe(base);
  });
  test('environment-only change publishes a new version', () => {
    expect(versionId('exports.handler = async () => 1;', { A: '2' }, false)).not.toBe(base);
  });
  test('combined code and environment change publishes a new version', () => {
    expect(versionId('exports.handler = async () => 2;', { A: '2' }, false)).not.toBe(base);
  });
  test('an unrelated stack change does not churn the version', () => {
    expect(versionId('exports.handler = async () => 1;', { A: '1' }, true)).toBe(base);
  });
  test('on the real stack, a change that does not touch the shared function keeps the same version', () => {
    const other = synthResources({ archiveOperatorPrincipalArn: 'arn:aws:iam::123456789012:role/another-operator' });
    const otherVersions = Object.entries(other).filter(([, r]) => r.Type === 'AWS::Lambda::Version').map(([id]) => id);
    expect(otherVersions).toEqual([versions[0][0]]);
  });
});
