/**
 * Value-free records for the daily API key rotation checker (WO-2026-09-30-001 design,
 * Revisions 5 and 6). Everything downstream of the metadata adapter -- the core, the SNS and
 * log emitters, the handler -- sees only these types. None has a field that could hold an
 * API key value, an upstream error, or an arbitrary object, and each is built field by field
 * at runtime, never by spreading an upstream object.
 *
 * Revision 6: no API Gateway key ID and no raw key name appear anywhere here. AWS documents
 * no format for a key ID and, historically, an ID could equal its key's value, so a key is
 * identified only by labels the checker derives from its own registry: consumer ID and slot.
 */
import { ApiKeySlot } from '../api-key-slots';

/** Which registry consumer and slot a deployed key belongs to; both from the registry. */
export interface KeySlotLabel {
  readonly consumerId: string;
  readonly slot: ApiKeySlot;
}

/** One deployed key, observed under a registry-derived label. */
export interface ObservedKeySlot extends KeySlotLabel {
  readonly enabled: boolean;
  readonly createdDate: Date;
}

/** A deployed key under a registry-derived label whose metadata could not be read. */
export interface MalformedKeySlot extends KeySlotLabel {
  readonly reason: MalformedKeyReason;
}
export type MalformedKeyReason = 'missing_created_date' | 'invalid_key_metadata';

/** Closed failure codes; nothing upstream (name, message, request ID) is ever carried. */
export type MetadataReadFailure =
  | 'api_gateway_read_failed'
  | 'invalid_metadata_page'
  | 'pagination_limit_exceeded';

export type KeyMetadataReadResult =
  | { readonly ok: true; readonly slots: readonly ObservedKeySlot[]; readonly malformed: readonly MalformedKeySlot[] }
  | { readonly ok: false; readonly failure: MetadataReadFailure };

export type CheckerFailure = MetadataReadFailure | 'alert_topic_not_configured' | 'unexpected_checker_error';

export interface KeySummary {
  readonly slot: ApiKeySlot;
  readonly enabled: boolean;
}

export type RotationEvent =
  | {
    readonly event: 'ingestion_api_key_rotation_overdue';
    readonly consumerId: string;
    readonly phase: 'overlap' | 'old-disabled' | null;
    readonly secondarySlot: ApiKeySlot;
    readonly secondaryKeyCreatedDate: string;
    readonly alertTargetAt: string;
    readonly daysOverdue: number;
    readonly keys: readonly KeySummary[];
  }
  | {
    readonly event: 'ingestion_api_key_rotation_inconsistency';
    readonly consumerId: string;
    readonly reason: InconsistencyReason;
    readonly keyCount: number;
    readonly keys: readonly KeySummary[];
  }
  | {
    readonly event: 'ingestion_api_key_rotation_checker_failed';
    readonly failure: CheckerFailure;
  };

export type InconsistencyReason =
  | 'ambiguous_key_names'
  | 'registry_api_key_config_invalid'
  | 'no_keys'
  | 'rotation_declared_with_one_key'
  | 'only_key_is_not_primary_slot'
  | 'secondary_not_newer_than_primary'
  | 'two_keys_without_declared_rotation'
  | MalformedKeyReason;

/** The one structured log line per run. Counts, consumer IDs, and closed codes only. */
export interface RotationRunSummary {
  readonly event: 'ingestion_api_key_rotation_check';
  readonly checkedAt: string;
  readonly consumersChecked: number;
  readonly overdue: readonly string[];
  readonly inconsistencies: readonly { readonly consumerId: string; readonly reason: InconsistencyReason }[];
  readonly failure: CheckerFailure | null;
  readonly publishFailures: number;
}
