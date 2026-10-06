import * as fs from 'fs';
import * as path from 'path';

// The single source of truth for "everywhere the ingestion webhook secret is configured" --
// see docs/security/webhook-secret-rotation-runbook.md. CDK reads this file to create each
// consumer's secret reference, API key, usage plan, and IAM grant; a generator (separate,
// see tools/) keeps the runbook's consumer table in sync with it, with CI failing if they
// drift -- the exact gap that let the Pi forwarder go undocumented in the 2026-09-18 incident.
//
// Contains identifiers and infrastructure metadata only. Never secret or API-key values --
// those live exclusively in Secrets Manager, created out-of-band, referenced here by name.

export interface IngestionConsumerUsagePlan {
  ratePerSecond: number;
  burst: number;
}

export type ApiKeySlot = 'a' | 'b';
export type ApiKeyRotationPhase = 'overlap' | 'old-disabled';

// Lifecycle metadata only -- never an API key value or an API key ID, and deliberately no
// timestamps: this file is bundled at build time and cannot know when a later deploy
// actually created a key. The rotation clock is the secondary key's own API Gateway
// createdDate, read by the daily checker (lambda/src/api-key-rotation-checker.ts). See
// docs/work-orders/WO-2026-09-30-001-design.md.
export interface IngestionConsumerApiKey {
  primarySlot: ApiKeySlot;
  rotation?: {
    secondarySlot: ApiKeySlot;
    phase: ApiKeyRotationPhase;
  };
}

export interface IngestionConsumer {
  id: string;
  displayName: string;
  secretName: string;
  usagePlan: IngestionConsumerUsagePlan;
  status: 'active' | 'inactive';
  apiKey: IngestionConsumerApiKey;
}

export interface IngestionConsumerRegistry {
  schemaVersion: number;
  consumers: IngestionConsumer[];
}

const CONSUMER_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const API_KEY_SLOTS: readonly string[] = ['a', 'b'];
const API_KEY_ROTATION_PHASES: readonly string[] = ['overlap', 'old-disabled'];

/**
 * The exact API Gateway key name CDK gives a consumer's slot. Slot `a` keeps the name every
 * consumer's key has had since before slots existed, so deploying the slot mechanism renames
 * nothing. The daily checker matches these names by full-string equality, so the same
 * convention is mirrored in lambda/src/api-key-slots.ts (an infra test pins the two together).
 */
export function apiKeySlotName(consumerId: string, slot: ApiKeySlot): string {
  return slot === 'a' ? `particle-ingestion-${consumerId}` : `particle-ingestion-${consumerId}-b`;
}

function rejectUnknownFields(registryPath: string, where: string, value: object, allowed: string[]): void {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new Error(`${registryPath}: ${where} has unsupported field "${field}"`);
    }
  }
}

function validateApiKey(registryPath: string, consumer: IngestionConsumer): void {
  const apiKey = consumer.apiKey as unknown;
  if (!apiKey || typeof apiKey !== 'object' || Array.isArray(apiKey)) {
    throw new Error(`${registryPath}: consumer "${consumer.id}" is missing apiKey`);
  }
  // Unknown fields are rejected, not ignored: a startedAt/expiresAt/deadline field here
  // would look like it bounds the rotation while nothing reads it.
  rejectUnknownFields(registryPath, `consumer "${consumer.id}" apiKey`, apiKey, ['primarySlot', 'rotation']);
  const { primarySlot, rotation } = apiKey as { primarySlot: unknown; rotation?: unknown };
  if (typeof primarySlot !== 'string' || !API_KEY_SLOTS.includes(primarySlot)) {
    throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid apiKey.primarySlot "${String(primarySlot)}"`);
  }
  if (rotation === undefined) return;
  if (!rotation || typeof rotation !== 'object' || Array.isArray(rotation)) {
    throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid apiKey.rotation`);
  }
  rejectUnknownFields(registryPath, `consumer "${consumer.id}" apiKey.rotation`, rotation, ['secondarySlot', 'phase']);
  const { secondarySlot, phase } = rotation as { secondarySlot: unknown; phase: unknown };
  if (typeof secondarySlot !== 'string' || !API_KEY_SLOTS.includes(secondarySlot)) {
    throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid apiKey.rotation.secondarySlot "${String(secondarySlot)}"`);
  }
  if (secondarySlot === primarySlot) {
    throw new Error(`${registryPath}: consumer "${consumer.id}" apiKey.rotation.secondarySlot must differ from primarySlot`);
  }
  if (typeof phase !== 'string' || !API_KEY_ROTATION_PHASES.includes(phase)) {
    throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid apiKey.rotation.phase "${String(phase)}"`);
  }
  if (consumer.status !== 'active') {
    throw new Error(`${registryPath}: consumer "${consumer.id}" declares an apiKey.rotation but is not active`);
  }
}

export function loadIngestionConsumerRegistry(registryPath: string): IngestionConsumer[] {
  const raw = fs.readFileSync(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as IngestionConsumerRegistry;

  if (parsed.schemaVersion !== 2) {
    throw new Error(`${registryPath}: unsupported schemaVersion ${parsed.schemaVersion} (expected 2)`);
  }
  if (!Array.isArray(parsed.consumers) || parsed.consumers.length === 0) {
    throw new Error(`${registryPath}: "consumers" must be a non-empty array`);
  }

  const seenIds = new Set<string>();
  const seenSecretNames = new Set<string>();
  // Every consumer owns both slot names, whether or not the second slot exists right now:
  // slots alternate across rotations, so a name only free today is still claimed.
  const slotNameOwners = new Map<string, string>();

  for (const consumer of parsed.consumers) {
    if (!CONSUMER_ID_PATTERN.test(consumer.id)) {
      throw new Error(`${registryPath}: consumer id "${consumer.id}" must be lowercase kebab-case`);
    }
    if (seenIds.has(consumer.id)) {
      throw new Error(`${registryPath}: duplicate consumer id "${consumer.id}"`);
    }
    seenIds.add(consumer.id);

    if (!consumer.secretName || typeof consumer.secretName !== 'string') {
      throw new Error(`${registryPath}: consumer "${consumer.id}" is missing secretName`);
    }
    if (seenSecretNames.has(consumer.secretName)) {
      throw new Error(`${registryPath}: duplicate secretName "${consumer.secretName}" (consumer "${consumer.id}")`);
    }
    seenSecretNames.add(consumer.secretName);

    const { ratePerSecond, burst } = consumer.usagePlan || ({} as IngestionConsumerUsagePlan);
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid usagePlan.ratePerSecond`);
    }
    if (!Number.isFinite(burst) || burst <= 0) {
      throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid usagePlan.burst`);
    }
    if (consumer.status !== 'active' && consumer.status !== 'inactive') {
      throw new Error(`${registryPath}: consumer "${consumer.id}" has an invalid status "${consumer.status}"`);
    }
    validateApiKey(registryPath, consumer);
  }

  // Checked after every id is known, so the result doesn't depend on registry order:
  // consumer "alpha" slot b and consumer "alpha-b" slot a would both be named
  // particle-ingestion-alpha-b, and the checker could not attribute that key to one owner.
  for (const consumer of parsed.consumers) {
    for (const slot of ['a', 'b'] as const) {
      const name = apiKeySlotName(consumer.id, slot);
      const owner = slotNameOwners.get(name);
      if (owner !== undefined) {
        throw new Error(`${registryPath}: API key name "${name}" is generated for both consumer "${owner}" and consumer "${consumer.id}"`);
      }
      slotNameOwners.set(name, consumer.id);
    }
  }

  return parsed.consumers;
}

export const DEFAULT_INGESTION_CONSUMER_REGISTRY_PATH = path.join(__dirname, '../../config/ingestion-consumers.json');
