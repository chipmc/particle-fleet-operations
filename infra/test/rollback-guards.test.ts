/**
 * Retained rollback guards (WO-2026-09-30-001 design, Revision 6, R3-2).
 *
 * After the alias foundation, nothing authorizes API Gateway to invoke the bare function.
 * Redeploying the pre-foundation template would switch integrations back to it, and that
 * template's REST permission names the stage, so it is created only after the stage already
 * serves the bare function: a window of 500s. The foundation therefore installs dormant,
 * route-scoped, wildcard-stage, account-scoped permissions on the bare function, with
 * DeletionPolicy and UpdateReplacePolicy Retain, so the statements survive that template
 * removing their resources.
 *
 * The rollback direction is modeled against a recorded extract of the pre-foundation
 * template (fixtures/pre-foundation-917a304.json). The live drill -- deploy foundation,
 * deploy the old template, confirm statements with GetPolicy, smoke-test every route --
 * cannot run here and is a required manual Phase 5/6 step:
 * docs/operations/wo-2026-09-30-001-foundation-rollback-drill.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';
import { referencesLogicalId } from './helpers/template-references';

interface PreFoundationExtract {
  functionLogicalId: string;
  httpRoutes: { routeLogicalId: string; integrationLogicalId: string; apiLogicalId: string; routeKey: string; integrationUri: unknown }[];
  restMethods: { methodLogicalId: string; apiLogicalId: string; httpMethod: string; path: string; integrationUri: unknown }[];
  bareFunctionPermissions: { logicalId: string; functionName: unknown; principal: string; sourceArn: unknown }[];
  restStages: { logicalId: string; deploymentId: unknown }[];
  restDeployments: { logicalId: string; dependsOn: string[] }[];
}
const preFoundation = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pre-foundation-917a304.json'), 'utf8')) as PreFoundationExtract;

const BREAK_GLASS_PRINCIPAL_ARN = 'arn:aws:iam::123456789012:role/test-archive-operator';

type Resource = { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[]; DeletionPolicy?: string; UpdateReplacePolicy?: string };
const resources = Template.fromStack(new InfraStack(new cdk.App({
  context: { archiveOperatorPrincipalArn: BREAK_GLASS_PRINCIPAL_ARN },
}), 'InfraStack')).toJSON().Resources as Record<string, Resource>;
const entries = Object.entries(resources);
const dependsOn = (r: Resource) => (Array.isArray(r.DependsOn) ? r.DependsOn : r.DependsOn ? [r.DependsOn] : []);

const functionId = preFoundation.functionLogicalId;
const bareFunctionArn = { 'Fn::GetAtt': [functionId, 'Arn'] };
const guards = entries.filter(([id]) => id.startsWith('IngestionRollbackGuard'));

/** execute-api ARN for one API logical ID, wildcard stage, exact method and path. */
function routeScopedArn(apiLogicalId: string, method: string, routePath: string): unknown {
  return {
    'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':execute-api:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':', { Ref: apiLogicalId }, `/*/${method}${routePath}`]],
  };
}

/** Every production method/path the shared function serves, read from the template. */
const productionRoutes = [
  ...entries.filter(([, r]) => r.Type === 'AWS::ApiGatewayV2::Route').map(([, r]) => {
    const [method, routePath] = (r.Properties.RouteKey as string).split(' ');
    return { api: (r.Properties.ApiId as { Ref: string }).Ref, method, path: routePath };
  }),
  { api: preFoundation.restMethods[0].apiLogicalId, method: 'POST', path: '/particle/log' },
];

describe('guard shape: route-scoped, wildcard-stage, account-scoped, retained', () => {
  test('one guard per production method/path, exactly', () => {
    expect(productionRoutes).toHaveLength(8);
    expect(entries.filter(([, r]) => r.Type === 'AWS::ApiGateway::Method').map(([, r]) => r.Properties.HttpMethod)).toEqual(['POST']);
    expect(guards).toHaveLength(productionRoutes.length);
    for (const route of productionRoutes) {
      const matching = guards.filter(([, g]) => JSON.stringify(g.Properties.SourceArn) === JSON.stringify(routeScopedArn(route.api, route.method, route.path)));
      expect({ route, matches: matching.length }).toEqual({ route, matches: 1 });
    }
  });

  test.each(guards.map(([id]) => [id]))('%s: exact properties and both retain policies', id => {
    const guard = resources[id];
    expect(guard.Type).toBe('AWS::Lambda::Permission');
    expect(guard.DeletionPolicy).toBe('Retain');
    expect(guard.UpdateReplacePolicy).toBe('Retain');
    expect(Object.keys(guard.Properties).sort()).toEqual(['Action', 'FunctionName', 'Principal', 'SourceAccount', 'SourceArn']);
    expect(guard.Properties.Action).toBe('lambda:InvokeFunction');
    expect(guard.Properties.FunctionName).toEqual(bareFunctionArn);
    expect(guard.Properties.Principal).toBe('apigateway.amazonaws.com');
    expect(guard.Properties.SourceAccount).toEqual({ Ref: 'AWS::AccountId' });
    // Stage-independent: the guard references no stage or deployment.
    for (const [otherId, other] of entries) {
      if (other.Type === 'AWS::ApiGateway::Stage' || other.Type === 'AWS::ApiGatewayV2::Stage' || other.Type === 'AWS::ApiGateway::Deployment') {
        expect({ guard: id, references: otherId, found: referencesLogicalId(guard, otherId) }).toEqual({ guard: id, references: otherId, found: false });
      }
    }
  });
});

describe('forward deploy: every guard exists before anything switches to the alias', () => {
  const guardIds = guards.map(([id]) => id);
  test('each HTTP integration, the HTTP default stage, and the REST deployment depend on every guard', () => {
    const switching = entries.filter(([, r]) => ['AWS::ApiGatewayV2::Integration', 'AWS::ApiGatewayV2::Stage', 'AWS::ApiGateway::Deployment'].includes(r.Type));
    expect(switching).toHaveLength(9);
    for (const [id, r] of switching) expect({ id, missing: guardIds.filter(g => !dependsOn(r).includes(g)) }).toEqual({ id, missing: [] });
  });
});

describe('rollback direction: redeploying the pre-foundation template over the foundation', () => {
  // Model, per CloudFormation's documented semantics: resources absent from the new template
  // are deleted, except that a resource with DeletionPolicy Retain leaves its physical
  // resource -- here, its statement in the function's resource policy -- in place.
  const oldTemplateIds = new Set<string>([
    ...preFoundation.httpRoutes.flatMap(r => [r.routeLogicalId, r.integrationLogicalId]),
    ...preFoundation.restMethods.map(m => m.methodLogicalId),
    ...preFoundation.bareFunctionPermissions.map(p => p.logicalId),
  ]);
  const retainedAfterRollback = entries
    .filter(([id, r]) => r.Type === 'AWS::Lambda::Permission' && !oldTemplateIds.has(id) && r.DeletionPolicy === 'Retain')
    .map(([, r]) => r);
  const authorizes = (statement: Resource, api: string, method: string, routePath: string) =>
    JSON.stringify(statement.Properties.FunctionName) === JSON.stringify(bareFunctionArn)
    && statement.Properties.Principal === 'apigateway.amazonaws.com'
    && JSON.stringify(statement.Properties.SourceArn) === JSON.stringify(routeScopedArn(api, method, routePath));

  test('the recorded old template targets the bare function on every route, through the same APIs', () => {
    expect(preFoundation.httpRoutes).toHaveLength(7);
    expect(preFoundation.restMethods).toHaveLength(1);
    for (const r of [...preFoundation.httpRoutes.map(h => h.integrationUri), ...preFoundation.restMethods.map(m => m.integrationUri)]) {
      expect(referencesLogicalId(r, functionId)).toBe(true);
    }
    for (const api of new Set([...preFoundation.httpRoutes.map(r => r.apiLogicalId), ...preFoundation.restMethods.map(m => m.apiLogicalId)])) {
      expect(resources[api]?.Type).toMatch(/^AWS::ApiGateway(V2)?::(Api|RestApi)$/);
    }
  });

  test('every old HTTP integration has a retained statement authorizing it before it can target the bare function', () => {
    for (const route of preFoundation.httpRoutes) {
      const [method, routePath] = route.routeKey.split(' ');
      expect({ route: route.routeKey, retained: retainedAfterRollback.some(s => authorizes(s, route.apiLogicalId, method, routePath)) })
        .toEqual({ route: route.routeKey, retained: true });
    }
  });

  test('REST ordering (R3-2): the old permission waits on the stage, but the retained guard does not', () => {
    // The hazard, read from the old template: its REST permission names the stage, and the
    // stage serves a deployment that depends on the method -- so the stage can serve the
    // bare-function integration before that permission can be created.
    const [method] = preFoundation.restMethods;
    const [stage] = preFoundation.restStages;
    const [deployment] = preFoundation.restDeployments;
    const oldRestPermission = preFoundation.bareFunctionPermissions.find(p => JSON.stringify(p.sourceArn).includes('/POST/particle/log') && referencesLogicalId(p.sourceArn, stage.logicalId));
    expect(oldRestPermission).toBeDefined();
    expect(stage.deploymentId).toEqual({ Ref: deployment.logicalId });
    expect(deployment.dependsOn).toContain(method.methodLogicalId);
    // The guard: already in the function policy, stage-independent, covering that method.
    const guard = retainedAfterRollback.find(s => authorizes(s, method.apiLogicalId, method.httpMethod, method.path));
    expect(guard).toBeDefined();
    expect(referencesLogicalId(guard, stage.logicalId)).toBe(false);
    expect(referencesLogicalId(guard, deployment.logicalId)).toBe(false);
  });

  test('without Retain, the same rollback would leave the old routes unauthorized (negative control)', () => {
    const retainedWithoutPolicy = entries
      .filter(([id, r]) => r.Type === 'AWS::Lambda::Permission' && !oldTemplateIds.has(id) && r.DeletionPolicy !== 'Retain');
    const withoutRetain = retainedWithoutPolicy.map(([, r]) => r);
    for (const route of preFoundation.httpRoutes) {
      const [m, p] = route.routeKey.split(' ');
      expect(withoutRetain.some(s => authorizes(s, route.apiLogicalId, m, p))).toBe(false);
    }
  });
});
