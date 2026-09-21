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

export interface IngestionConsumer {
  id: string;
  displayName: string;
  secretName: string;
  usagePlan: IngestionConsumerUsagePlan;
  status: 'active' | 'inactive';
}

export interface IngestionConsumerRegistry {
  schemaVersion: number;
  consumers: IngestionConsumer[];
}

const CONSUMER_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function loadIngestionConsumerRegistry(registryPath: string): IngestionConsumer[] {
  const raw = fs.readFileSync(registryPath, 'utf8');
  const parsed = JSON.parse(raw) as IngestionConsumerRegistry;

  if (parsed.schemaVersion !== 1) {
    throw new Error(`${registryPath}: unsupported schemaVersion ${parsed.schemaVersion} (expected 1)`);
  }
  if (!Array.isArray(parsed.consumers) || parsed.consumers.length === 0) {
    throw new Error(`${registryPath}: "consumers" must be a non-empty array`);
  }

  const seenIds = new Set<string>();
  const seenSecretNames = new Set<string>();

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
  }

  return parsed.consumers;
}

export const DEFAULT_INGESTION_CONSUMER_REGISTRY_PATH = path.join(__dirname, '../../config/ingestion-consumers.json');
