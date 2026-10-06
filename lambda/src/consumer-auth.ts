/**
 * Per-consumer credential validation for the ingestion REST API (custom domain,
 * ingest.seeinsights.com). Replaces the single shared-secret equality check with an
 * allow-list lookup: each registered consumer has its own webhook secret (Secrets
 * Manager) and its own API Gateway API key. A request must present both, and both must
 * resolve to the *same* consumer, before it's accepted.
 *
 * See docs/security/webhook-secret-rotation-runbook.md for the design history and the
 * incident (2026-09-18) this replaces the single shared secret to fix.
 *
 * The consumer *registry* (config/ingestion-consumers.json -- ids, secret names, usage
 * plan numbers; never secret values) is static infra metadata, bundled at build time,
 * not fetched at runtime. Only the secret *values* are fetched live, from Secrets
 * Manager, with a short in-memory cache -- so onboarding a new consumer is a registry
 * entry + a pre-created secret + a redeploy, not a runtime-mutable thing.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import consumerRegistry from '../../config/ingestion-consumers.json';
import { ConsumerApiKeyConfig, apiKeyConfigProblem, primaryKeyIdEnvVar, rotationKeyIdEnvVar } from './api-key-slots';

export interface IngestionConsumer {
  id: string;
  displayName: string;
  secretName: string;
  usagePlan: { ratePerSecond: number; burst: number };
  status: 'active' | 'inactive';
  apiKey: ConsumerApiKeyConfig;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedAt = 0;
let cachedSecretsByConsumerId: Map<string, string> | undefined;

const secretsManager = new SecretsManagerClient({});

/** The real, active consumers from the checked-in registry -- production default. */
export function activeConsumers(): IngestionConsumer[] {
  return (consumerRegistry.consumers as unknown as IngestionConsumer[]).filter(c => c.status === 'active');
}

/** Test-only: clears the in-memory secret cache so a test doesn't leak state into the next. */
export function resetConsumerAuthCacheForTests(): void {
  cachedSecretsByConsumerId = undefined;
  cachedAt = 0;
}

async function loadConsumerSecrets(now: number, consumers: IngestionConsumer[]): Promise<Map<string, string>> {
  if (cachedSecretsByConsumerId && now - cachedAt < CACHE_TTL_MS) {
    return cachedSecretsByConsumerId;
  }
  const entries = await Promise.all(consumers.map(async consumer => {
    const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: consumer.secretName }));
    if (!response.SecretString) throw new Error(`Secret ${consumer.secretName} has no SecretString`);
    return [consumer.id, response.SecretString] as const;
  }));
  cachedSecretsByConsumerId = new Map(entries);
  cachedAt = now;
  return cachedSecretsByConsumerId;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * What one presented API key ID resolves to. `config-error` is scoped to the consumer(s)
 * whose key-ID configuration is malformed: their known IDs answer 503, while every other
 * consumer's IDs keep resolving normally. `unknown` keeps the existing pair-mismatch (401)
 * behavior.
 */
export type ApiKeyLookupResult =
  | { kind: 'consumer'; consumerId: string }
  | { kind: 'config-error'; consumerIds: string[]; reason: string }
  | { kind: 'unknown' };

export type ConsumerAuthResult =
  | { outcome: 'success'; consumerId: string }
  | { outcome: 'failure'; reason: 'missing_secret' | 'invalid_secret' | 'credential_pair_mismatch' | 'credential_config_unavailable'; apiKeyConsumerId?: string };

/**
 * Validates a request's webhook-secret header against every active consumer's secret,
 * and cross-checks the result against which consumer the API key (already validated by
 * API Gateway itself before this Lambda ever runs) belongs to.
 *
 * Constant-time by construction: every active candidate is hashed and compared via
 * `timingSafeEqual`, with no early exit on the first match -- so the total work done,
 * and therefore the response time, does not vary based on which candidate (if any)
 * matches. This closes a timing side-channel that a naive `secret === candidate` loop
 * with an early `return` would otherwise leak (which candidate matched, or whether any
 * did, becomes observable from response latency alone).
 */
export async function validateConsumerRequest(
  providedSecret: string | undefined,
  apiKeyId: string | undefined,
  lookupApiKey: (apiKeyId: string) => ApiKeyLookupResult,
  consumers: IngestionConsumer[] = activeConsumers()
): Promise<ConsumerAuthResult> {
  if (!providedSecret) {
    return { outcome: 'failure', reason: 'missing_secret' };
  }

  let secretsByConsumerId: Map<string, string>;
  try {
    secretsByConsumerId = await loadConsumerSecrets(Date.now(), consumers);
  } catch (error) {
    console.error(JSON.stringify({ event: 'consumer_auth_config_unavailable', error: error instanceof Error ? error.message : String(error) }));
    return { outcome: 'failure', reason: 'credential_config_unavailable' };
  }

  const providedDigest = sha256(providedSecret);
  const matchedConsumerIds: string[] = [];
  // No early exit: every active candidate is checked, every time, regardless of whether
  // an earlier one already matched.
  for (const [consumerId, candidateSecret] of secretsByConsumerId) {
    const candidateDigest = sha256(candidateSecret);
    if (timingSafeEqual(providedDigest, candidateDigest)) {
      matchedConsumerIds.push(consumerId);
    }
  }

  // Resolved only after every candidate has been compared, so a misconfigured or unknown
  // key does not shorten the comparison loop above.
  const keyResult: ApiKeyLookupResult = apiKeyId ? lookupApiKey(apiKeyId) : { kind: 'unknown' };
  const apiKeyConsumerId = keyResult.kind === 'consumer'
    ? keyResult.consumerId
    : keyResult.kind === 'config-error' && keyResult.consumerIds.length === 1 ? keyResult.consumerIds[0] : undefined;

  if (matchedConsumerIds.length > 1) {
    // Two active consumers configured with the same secret value -- a deployment/
    // configuration error (the registry's own schema validation rejects duplicate
    // *names*, but two different consumers' Secrets Manager entries could still be
    // hand-set to the same value by mistake). Refuse rather than guess which one.
    console.error(JSON.stringify({ event: 'consumer_auth_duplicate_secret', consumerIds: matchedConsumerIds }));
    return { outcome: 'failure', reason: 'credential_config_unavailable' };
  }
  if (keyResult.kind === 'config-error') {
    // This key belongs to a consumer whose key-ID configuration is malformed (e.g. a
    // declared rotation with no secondary ID). 503 for that consumer only; other consumers'
    // keys never resolve to this result. Logs IDs and a fixed reason, never a credential.
    console.error(JSON.stringify({ event: 'consumer_auth_api_key_config_error', consumerIds: keyResult.consumerIds, reason: keyResult.reason, apiKeyId }));
    return { outcome: 'failure', reason: 'credential_config_unavailable', apiKeyConsumerId };
  }
  if (matchedConsumerIds.length === 0) {
    return { outcome: 'failure', reason: 'invalid_secret', apiKeyConsumerId };
  }

  const secretConsumerId = matchedConsumerIds[0];
  if (!apiKeyConsumerId || apiKeyConsumerId !== secretConsumerId) {
    return { outcome: 'failure', reason: 'credential_pair_mismatch', apiKeyConsumerId };
  }

  return { outcome: 'success', consumerId: secretConsumerId };
}

/**
 * Non-secret API-key-ID-to-consumer mapping, derived from the same registry. API key
 * IDs are not sensitive (they identify a key, not its value), so this is safe to bundle
 * at build time same as the rest of the registry -- but the mapping from a *specific*
 * API Gateway-assigned key ID to a consumer ID isn't in the registry file itself (that ID
 * only exists after CDK creates the ApiKey resource), so it's supplied via environment
 * variables at deploy time instead, per active consumer:
 * INGESTION_API_KEY_ID_<CONSUMER_ID_UPPER_SNAKE> = <primary slot's key id>, plus, only
 * while the registry declares a rotation,
 * INGESTION_API_KEY_ROTATION_ID_<CONSUMER_ID_UPPER_SNAKE> = <secondary slot's key id>.
 *
 * Each consumer is validated independently. A malformed one maps only its own known IDs to
 * `config-error`; it never throws or discards the rest of the map. An ID claimed by two
 * consumers is `config-error` for both, never resolved by registry order. There is no
 * deadline here: an old key keeps resolving until cleanup removes its ID, and API Gateway,
 * not this Lambda's clock, rejects a disabled key.
 */
export function buildApiKeyConsumerLookup(
  env: NodeJS.ProcessEnv,
  consumers: IngestionConsumer[] = activeConsumers()
): (apiKeyId: string) => ApiKeyLookupResult {
  const claimsByApiKeyId = new Map<string, { consumerId: string; problem?: string }[]>();
  for (const consumer of consumers) {
    const primaryId = env[primaryKeyIdEnvVar(consumer.id)] || undefined;
    const secondaryId = env[rotationKeyIdEnvVar(consumer.id)] || undefined;
    let problem = apiKeyConfigProblem(consumer.apiKey);
    if (!problem) {
      const isRotationDeclared = consumer.apiKey.rotation !== undefined;
      if (isRotationDeclared && !secondaryId) problem = 'missing_secondary_key_id';
      else if (isRotationDeclared && !primaryId) problem = 'missing_primary_key_id';
      else if (!isRotationDeclared && secondaryId) problem = 'undeclared_secondary_key_id';
      else if (primaryId && primaryId === secondaryId) problem = 'secondary_key_id_equals_primary';
    }
    // An ID that was never supplied can't be attributed to anyone, so it stays unknown;
    // whichever of this consumer's IDs *are* known carry the problem.
    for (const knownId of new Set([primaryId, secondaryId])) {
      if (!knownId) continue;
      const claims = claimsByApiKeyId.get(knownId) ?? [];
      claims.push({ consumerId: consumer.id, problem });
      claimsByApiKeyId.set(knownId, claims);
    }
  }

  const byApiKeyId = new Map<string, ApiKeyLookupResult>();
  for (const [apiKeyId, claims] of claimsByApiKeyId) {
    const consumerIds = [...new Set(claims.map(claim => claim.consumerId))];
    if (consumerIds.length > 1) {
      byApiKeyId.set(apiKeyId, { kind: 'config-error', consumerIds, reason: 'duplicate_api_key_id' });
    } else if (claims[0].problem) {
      byApiKeyId.set(apiKeyId, { kind: 'config-error', consumerIds, reason: claims[0].problem });
    } else {
      byApiKeyId.set(apiKeyId, { kind: 'consumer', consumerId: consumerIds[0] });
    }
  }
  return (apiKeyId: string) => byApiKeyId.get(apiKeyId) ?? { kind: 'unknown' };
}
