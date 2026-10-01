/**
 * Daily ingestion API key rotation checker (EventBridge, 09:00 UTC). Alert-only: it never
 * disables, deletes, or blocks anything. See docs/work-orders/WO-2026-09-30-001-design.md §3.
 *
 * Rotation state comes from what API Gateway actually holds, not from the registry's
 * declaration: for each registered consumer it counts the keys whose names exactly equal
 * that consumer's two slot names. One key is the steady state. Two keys -- both enabled
 * (`overlap`) or one disabled (`old-disabled`) -- is a rotation in progress, and its clock
 * starts at the secondary key's own API Gateway `createdDate`. Once that is 168 hours old,
 * every daily run publishes one overdue event per consumer until cleanup leaves one key.
 * Zero keys, a duplicated name, a declared rotation with only one key, two keys with no
 * declared rotation, or a missing date are published as inconsistencies, never read as
 * healthy.
 *
 * Credential values: this role's apigateway:GET on /apikeys cannot be limited to
 * value-free reads -- IAM does not distinguish includeValue(s) true from false. Only this
 * code keeps values out: it sends exactly two read commands, each with the include flag
 * set false, and copies a fixed set of non-sensitive fields (id, name, enabled,
 * createdDate) out of each response. api-key-rotation-checker.test.ts fails on any other
 * command or flag, and on any value reaching an alert or log. GetUsagePlanKeys returns
 * values and is never called.
 */
import { APIGatewayClient, GetApiKeyCommand, GetApiKeysCommand } from '@aws-sdk/client-api-gateway';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import consumerRegistry from '../../config/ingestion-consumers.json';
import { ApiKeySlot, ConsumerApiKeyConfig, apiKeyConfigProblem, apiKeySlotName } from './api-key-slots';

export const ROTATION_ALERT_TARGET_MS = 168 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GET_API_KEYS_PAGE_LIMIT = 500;

export interface CheckerConsumer {
  id: string;
  apiKey: ConsumerApiKeyConfig;
}

interface KeyMetadata {
  id: string;
  name: string;
  enabled: boolean;
  createdDate: Date | undefined;
}

export type RotationEvent =
  | {
    event: 'ingestion_api_key_rotation_overdue';
    consumerId: string;
    phase: string | null;
    secondaryKeyId: string;
    secondaryKeyCreatedDate: string;
    alertTargetAt: string;
    daysOverdue: number;
    keys: { id: string; slot: ApiKeySlot; enabled: boolean }[];
  }
  | {
    event: 'ingestion_api_key_rotation_inconsistency';
    consumerId: string;
    reason: string;
    keyCount: number;
    keys: { id: string; slot: ApiKeySlot; enabled: boolean }[];
  };

/** Narrow client shapes, so tests can see (and refuse) every command the checker sends. */
export interface ApiGatewayReader {
  send(command: GetApiKeysCommand | GetApiKeyCommand): Promise<unknown>;
}
export interface SnsPublisher {
  send(command: PublishCommand): Promise<unknown>;
}

export interface RotationCheckDeps {
  apiGateway: ApiGatewayReader;
  sns: SnsPublisher;
  topicArn: string;
  now: Date;
  consumers: CheckerConsumer[];
}

/**
 * The SDK deserializes createdDate to a Date (epoch seconds on the wire); the CLI prints
 * the same instant as ISO 8601 with a UTC offset. Accept either, nothing looser.
 */
function parseCreatedDate(raw: unknown): Date | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

/** Copies only non-sensitive fields; a response's `value`, if one ever appeared, is dropped here. */
function toKeyMetadata(item: unknown): KeyMetadata | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const { id, name, enabled, createdDate } = item as Record<string, unknown>;
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  return { id, name, enabled: enabled === true, createdDate: parseCreatedDate(createdDate) };
}

/**
 * The SDK copies a service error body's message into the thrown error, and nothing rules
 * out that text echoing request or response content. Only the error's name, HTTP status
 * and request ID are relayed -- enough to look the failure up, never upstream text.
 */
function describeAwsError(operation: string, error: unknown): string {
  const { name, $metadata } = (error ?? {}) as { name?: unknown; $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };
  const safe = (value: unknown) => (typeof value === 'string' || typeof value === 'number') && /^[\w.:-]+$/.test(String(value)) ? String(value) : 'unknown';
  return `${operation} failed: ${safe(name)} (HTTP ${safe($metadata?.httpStatusCode)}, request ${safe($metadata?.requestId)})`;
}

async function listAllApiKeys(apiGateway: ApiGatewayReader): Promise<KeyMetadata[]> {
  const keys: KeyMetadata[] = [];
  let position: string | undefined;
  do {
    let page: { items?: unknown[]; position?: string };
    try {
      page = await apiGateway.send(new GetApiKeysCommand({
        includeValues: false,
        limit: GET_API_KEYS_PAGE_LIMIT,
        position,
      })) as { items?: unknown[]; position?: string };
    } catch (error) {
      throw new Error(describeAwsError('GetApiKeys', error));
    }
    for (const item of page.items ?? []) {
      const key = toKeyMetadata(item);
      if (key) keys.push(key);
    }
    position = page.position;
  } while (position);
  return keys;
}

async function getKeyMetadata(apiGateway: ApiGatewayReader, apiKeyId: string): Promise<KeyMetadata | undefined> {
  const response = await apiGateway.send(new GetApiKeyCommand({ apiKey: apiKeyId, includeValue: false }));
  return toKeyMetadata(response);
}

function summarize(keys: { slot: ApiKeySlot; key: KeyMetadata }[]): { id: string; slot: ApiKeySlot; enabled: boolean }[] {
  return keys.map(({ slot, key }) => ({ id: key.id, slot, enabled: key.enabled }));
}

async function evaluateConsumer(
  consumer: CheckerConsumer,
  keysByName: Map<string, KeyMetadata[]>,
  deps: RotationCheckDeps,
  metadataErrors: string[]
): Promise<RotationEvent[]> {
  const inconsistency = (reason: string, keys: { slot: ApiKeySlot; key: KeyMetadata }[], keyCount = keys.length): RotationEvent =>
    ({ event: 'ingestion_api_key_rotation_inconsistency', consumerId: consumer.id, reason, keyCount, keys: summarize(keys) });

  const matchesA = keysByName.get(apiKeySlotName(consumer.id, 'a')) ?? [];
  const matchesB = keysByName.get(apiKeySlotName(consumer.id, 'b')) ?? [];
  const slotted = [
    ...matchesA.map(key => ({ slot: 'a' as const, key })),
    ...matchesB.map(key => ({ slot: 'b' as const, key })),
  ];
  if (matchesA.length > 1 || matchesB.length > 1) {
    return [inconsistency('ambiguous_key_names', slotted)];
  }
  const configProblem = apiKeyConfigProblem(consumer.apiKey);
  if (configProblem) {
    return [inconsistency(`registry_${configProblem}`, slotted)];
  }
  const { primarySlot, rotation } = consumer.apiKey;

  if (slotted.length === 0) return [inconsistency('no_keys', slotted)];
  if (slotted.length === 1) {
    if (rotation) return [inconsistency('rotation_declared_with_one_key', slotted)];
    if (slotted[0].slot !== primarySlot) return [inconsistency('only_key_is_not_primary_slot', slotted)];
    // Steady state needs a readable creation date too: a key whose metadata can't be read
    // is never reported healthy, whatever the key count.
    if (!slotted[0].key.createdDate) return [inconsistency('missing_created_date', slotted)];
    return [];
  }

  // Two keys: a rotation is in progress whether or not both are enabled, and whether or not
  // the registry still declares it. Re-read each by ID for its creation time.
  const fresh: { slot: ApiKeySlot; key: KeyMetadata }[] = [];
  for (const { slot, key } of slotted) {
    try {
      const detail = await getKeyMetadata(deps.apiGateway, key.id);
      fresh.push({ slot, key: detail ?? { ...key, createdDate: undefined } });
    } catch (error) {
      metadataErrors.push(`${consumer.id}: GetApiKey ${key.id} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      fresh.push({ slot, key: { ...key, createdDate: undefined } });
    }
  }
  if (fresh.some(({ key }) => !key.createdDate)) {
    return [inconsistency('missing_created_date', fresh)];
  }

  const events: RotationEvent[] = [];
  let secondary: { slot: ApiKeySlot; key: KeyMetadata };
  if (rotation) {
    secondary = fresh.find(({ slot }) => slot === rotation.secondarySlot)!;
    const primary = fresh.find(({ slot }) => slot === primarySlot)!;
    if (secondary.key.createdDate!.getTime() <= primary.key.createdDate!.getTime()) {
      events.push(inconsistency('secondary_not_newer_than_primary', fresh));
    }
  } else {
    events.push(inconsistency('two_keys_without_declared_rotation', fresh));
    secondary = fresh.reduce((newer, entry) =>
      entry.key.createdDate!.getTime() > newer.key.createdDate!.getTime() ? entry : newer);
  }

  const alertTargetMs = secondary.key.createdDate!.getTime() + ROTATION_ALERT_TARGET_MS;
  if (deps.now.getTime() >= alertTargetMs) {
    events.push({
      event: 'ingestion_api_key_rotation_overdue',
      consumerId: consumer.id,
      phase: rotation?.phase ?? null,
      secondaryKeyId: secondary.key.id,
      secondaryKeyCreatedDate: secondary.key.createdDate!.toISOString(),
      alertTargetAt: new Date(alertTargetMs).toISOString(),
      daysOverdue: Math.floor((deps.now.getTime() - alertTargetMs) / DAY_MS),
      keys: summarize(fresh),
    });
  }
  return events;
}

function subjectFor(event: RotationEvent): string {
  return event.event === 'ingestion_api_key_rotation_overdue'
    ? `Ingestion API key rotation overdue: ${event.consumerId}`
    : `Ingestion API key rotation inconsistency: ${event.consumerId}`;
}

/**
 * One run of the check. Publishes every event it finds, then throws if any key metadata
 * read or any publish failed, so the function's Errors alarm fires instead of the failure
 * passing as a quiet day.
 */
export async function runRotationCheck(deps: RotationCheckDeps): Promise<RotationEvent[]> {
  const keysByName = new Map<string, KeyMetadata[]>();
  for (const key of await listAllApiKeys(deps.apiGateway)) {
    keysByName.set(key.name, [...(keysByName.get(key.name) ?? []), key]);
  }

  const metadataErrors: string[] = [];
  const events: RotationEvent[] = [];
  for (const consumer of deps.consumers) {
    events.push(...await evaluateConsumer(consumer, keysByName, deps, metadataErrors));
  }

  const publishErrors: string[] = [];
  for (const event of events) {
    try {
      await deps.sns.send(new PublishCommand({
        TopicArn: deps.topicArn,
        Subject: subjectFor(event),
        Message: JSON.stringify(event, null, 2),
      }));
    } catch (error) {
      publishErrors.push(`${event.event} ${event.consumerId}: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  console.info(JSON.stringify({
    event: 'ingestion_api_key_rotation_check',
    checkedAt: deps.now.toISOString(),
    consumersChecked: deps.consumers.length,
    overdue: events.filter(e => e.event === 'ingestion_api_key_rotation_overdue').map(e => e.consumerId),
    inconsistencies: events
      .filter((e): e is Extract<RotationEvent, { event: 'ingestion_api_key_rotation_inconsistency' }> =>
        e.event === 'ingestion_api_key_rotation_inconsistency')
      .map(e => ({ consumerId: e.consumerId, reason: e.reason })),
    metadataErrors: metadataErrors.length,
    publishErrors: publishErrors.length,
  }));

  const failures = [...metadataErrors, ...publishErrors];
  if (failures.length > 0) {
    throw new Error(`API key rotation check failed: ${failures.join('; ')}`);
  }
  return events;
}

/** Every registered consumer (active or not) from the bundled registry -- each owns key names. */
function registeredConsumers(): CheckerConsumer[] {
  return (consumerRegistry.consumers as unknown as CheckerConsumer[]).map(({ id, apiKey }) => ({ id, apiKey }));
}

export async function handler(): Promise<void> {
  const topicArn = process.env.ROTATION_ALERT_TOPIC_ARN;
  if (!topicArn) throw new Error('ROTATION_ALERT_TOPIC_ARN is not set');
  await runRotationCheck({
    apiGateway: new APIGatewayClient({}),
    sns: new SNSClient({}),
    topicArn,
    now: new Date(),
    consumers: registeredConsumers(),
  });
}
