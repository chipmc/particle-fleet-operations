/**
 * Deploy-boundary fixtures for WO-2026-09-30-001 design, Revision 4 (Codex round-1 F1).
 *
 * Models the Lambda deployment semantics the design relies on, as AWS documents them:
 * CloudFormation updates a function's code and configuration as two sequential calls, in
 * either order, with invocations possible in between; a published version is an immutable
 * snapshot of code and configuration together; the `prod` alias is a pointer that moves only
 * when CloudFormation updates it, after the version exists. (AWS::Lambda::Function, Lambda
 * versions and aliases documentation, as cited in the design.) The synthesized wiring -- every
 * production integration on the alias, the version built from the complete function -- is
 * asserted separately in infra/test/lambda-alias.test.ts.
 *
 * Each snapshot runs the real handleIngestion and consumer-auth.ts with that snapshot's
 * bundled registry and environment. The auth checks are not loosened: the negative control
 * shows the same mixed state still returns 503 when invoked directly as $LATEST.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { handleIngestion } from '../ingestion';
import { resetConsumerAuthCacheForTests } from '../consumer-auth';

jest.mock('../../../config/ingestion-consumers.json', () => ({ schemaVersion: 2, consumers: [] }));
const mockRegistry: { consumers: unknown[] } = jest.requireMock('../../../config/ingestion-consumers.json');
jest.mock('../storage/s3');
jest.mock('../storage/dynamo');
jest.mock('../storage/current-state');
jest.mock('../integrations/particle-api');

const SECRET: Record<string, string> = {
  alpha: 'alpha-webhook-secret-fixture-'.padEnd(64, 'x'),
  beta: 'beta-webhook-secret-fixture-'.padEnd(64, 'y'),
};

type Env = Readonly<Record<string, string>>;
interface Snapshot { readonly registry: readonly unknown[]; readonly env: Env }

const consumer = (id: string, apiKey: unknown) => ({
  id, displayName: id, secretName: `test/consumers/${id}/webhook-secret`, usagePlan: { ratePerSecond: 10, burst: 50 }, status: 'active', apiKey,
});
const BETA = consumer('beta', { primarySlot: 'a' });

/** The four registry phases of one alpha rotation, each with the environment CDK synthesizes for it. */
const PHASES: Record<'steady' | 'overlap' | 'oldDisabled' | 'cleanup', Snapshot> = {
  steady: {
    registry: [consumer('alpha', { primarySlot: 'a' }), BETA],
    env: { INGESTION_API_KEY_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ID_BETA: 'beta-a' },
  },
  overlap: {
    registry: [consumer('alpha', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'overlap' } }), BETA],
    env: { INGESTION_API_KEY_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ROTATION_ID_ALPHA: 'alpha-b', INGESTION_API_KEY_ID_BETA: 'beta-a' },
  },
  oldDisabled: {
    registry: [consumer('alpha', { primarySlot: 'a', rotation: { secondarySlot: 'b', phase: 'old-disabled' } }), BETA],
    env: { INGESTION_API_KEY_ID_ALPHA: 'alpha-a', INGESTION_API_KEY_ROTATION_ID_ALPHA: 'alpha-b', INGESTION_API_KEY_ID_BETA: 'beta-a' },
  },
  cleanup: {
    registry: [consumer('alpha', { primarySlot: 'b' }), BETA],
    env: { INGESTION_API_KEY_ID_ALPHA: 'alpha-b', INGESTION_API_KEY_ID_BETA: 'beta-a' },
  },
};

/** $LATEST, immutable published versions, and the prod alias, per AWS's documented semantics. */
class LambdaModel {
  private code: readonly unknown[];
  private configuration: Env;
  private readonly versions: Snapshot[] = [];
  private aliasVersion: number;

  constructor(initial: Snapshot) {
    this.code = initial.registry;
    this.configuration = initial.env;
    this.aliasVersion = this.publishVersion();
  }
  updateFunctionCode(registry: readonly unknown[]): void { this.code = registry; }
  updateFunctionConfiguration(env: Env): void { this.configuration = env; }
  publishVersion(): number {
    this.versions.push(Object.freeze({ registry: this.code, env: Object.freeze({ ...this.configuration }) }));
    return this.versions.length - 1;
  }
  updateAlias(version: number): void { this.aliasVersion = version; }
  get prodVersion(): number { return this.aliasVersion; }
  resolve(target: 'prod' | '$LATEST' | number): Snapshot {
    if (target === '$LATEST') return { registry: this.code, env: this.configuration };
    return this.versions[target === 'prod' ? this.aliasVersion : target];
  }
}

const originalEnv = process.env;
beforeEach(() => {
  jest.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async command => {
    if (!(command instanceof GetSecretValueCommand)) throw new Error('unexpected command');
    const id = /test\/consumers\/([^/]+)\//.exec(command.input.SecretId!)![1];
    return { SecretString: SECRET[id] } as never;
  });
  for (const method of ['error', 'warn', 'info', 'log'] as const) jest.spyOn(console, method).mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

/** API Gateway rejects a disabled key with 403 before invoking; otherwise run the snapshot. */
async function request(snapshot: Snapshot, apiKeyId: string, secretOf: string, disabledKeys: ReadonlySet<string> = new Set()): Promise<number> {
  if (disabledKeys.has(apiKeyId)) return 403;
  mockRegistry.consumers = [...snapshot.registry];
  process.env = { ...originalEnv, ...snapshot.env };
  resetConsumerAuthCacheForTests();
  const response = await handleIngestion({
    body: JSON.stringify({ event: 'status', coreid: 'device123', published_at: '2026-09-21T00:00:00.000Z' }),
    headers: { 'x-particle-webhook-secret': SECRET[secretOf] },
    apiKeyId,
    requestContext: { http: { sourceIp: '203.0.113.5', userAgent: 'test-agent' } },
  });
  return response.statusCode;
}

type Order = 'code-first' | 'configuration-first';
const DEPLOYS: [string, Snapshot, Snapshot, string][] = [
  ['deploy 1 (create overlap)', PHASES.steady, PHASES.overlap, 'alpha-a'],
  ['deploy 3 (cleanup and promote)', PHASES.oldDisabled, PHASES.cleanup, 'alpha-b'],
];

describe.each(DEPLOYS)('%s', (_label, from, to, liveKey) => {
  test.each(['code-first', 'configuration-first'] as Order[])('%s: every stage of the update returns 200 for the live key through prod', async order => {
    const fn = new LambdaModel(from);
    const oldVersion = fn.prodVersion;
    const steps: [string, () => void][] = order === 'code-first'
      ? [['code updated', () => fn.updateFunctionCode(to.registry)], ['configuration updated', () => fn.updateFunctionConfiguration(to.env)]]
      : [['configuration updated', () => fn.updateFunctionConfiguration(to.env)], ['code updated', () => fn.updateFunctionCode(to.registry)]];

    const statuses: Record<string, number> = {};
    const atStage = async (stage: string) => {
      statuses[`${stage}: alpha ${liveKey}`] = await request(fn.resolve('prod'), liveKey, 'alpha');
      statuses[`${stage}: beta beta-a`] = await request(fn.resolve('prod'), 'beta-a', 'beta');
    };

    await atStage('before function update');
    steps[0][1]();
    // Between the two calls $LATEST is mixed; prod still resolves to the old, complete version.
    expect(fn.prodVersion).toBe(oldVersion);
    expect(fn.resolve('prod')).toEqual(from);
    await atStage(`between calls (${steps[0][0]})`);
    steps[1][1]();
    await atStage('function update complete');
    const newVersion = fn.publishVersion();
    expect(fn.resolve(newVersion)).toEqual(to);
    await atStage('after version publication');
    fn.updateAlias(newVersion);
    expect(fn.resolve('prod')).toEqual(to);
    await atStage('after alias update');

    expect(Object.values(statuses)).toEqual(Object.values(statuses).map(() => 200));
    expect(Object.keys(statuses)).toHaveLength(10);
  });

  test.each(['code-first', 'configuration-first'] as Order[])('%s negative control: the same mixed state invoked directly as $LATEST still fails 503', async order => {
    const fn = new LambdaModel(from);
    if (order === 'code-first') fn.updateFunctionCode(to.registry);
    else fn.updateFunctionConfiguration(to.env);
    expect(await request(fn.resolve('$LATEST'), liveKey, 'alpha')).toBe(503);
    // ...while prod, on the coherent old version, keeps serving the same request.
    expect(await request(fn.resolve('prod'), liveKey, 'alpha')).toBe(200);
  });
});

describe('alias propagation: requests may reach either adjacent version', () => {
  test('deploy 1: the old key succeeds in both steady and overlap', async () => {
    for (const v of [PHASES.steady, PHASES.overlap]) expect(await request(v, 'alpha-a', 'alpha')).toBe(200);
  });

  test('deploy 2: the new key succeeds in overlap and old-disabled; the old key follows API Gateway enablement', async () => {
    for (const v of [PHASES.overlap, PHASES.oldDisabled]) {
      expect(await request(v, 'alpha-b', 'alpha')).toBe(200);
      expect(await request(v, 'alpha-a', 'alpha')).toBe(200);
      expect(await request(v, 'alpha-a', 'alpha', new Set(['alpha-a']))).toBe(403);
      expect(await request(v, 'alpha-b', 'alpha', new Set(['alpha-a']))).toBe(200);
    }
  });

  test('deploy 3: the new key succeeds in old-disabled and cleanup', async () => {
    for (const v of [PHASES.oldDisabled, PHASES.cleanup]) expect(await request(v, 'alpha-b', 'alpha')).toBe(200);
  });
});
