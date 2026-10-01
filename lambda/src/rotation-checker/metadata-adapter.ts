/**
 * The checker's only contact with API Gateway, and the only module allowed to import the
 * API Gateway SDK (WO-2026-09-30-001 design, Revisions 5 and 6). It erases everything except
 * what the checker needs before anything leaves this file:
 *
 * - It sends exactly one command, `GetApiKeys` with `includeValues: false`, paginated. No
 *   `GetApiKey`, no `GetUsagePlanKeys`. Each item already carries name, enabled, and
 *   createdDate.
 * - It reads an item's `name` only to look it up, by exact equality, among the slot names
 *   derived from the registry. For a match it reads `enabled` and `createdDate` -- as own
 *   data properties, so no getter ever runs -- and builds a fresh `ObservedKeySlot` labeled
 *   with the registry's consumer ID and slot. The raw name is not returned. The key's `id`
 *   is never read at all: AWS documents no format for it and it could equal the key's value
 *   (Revision 6, R3-1). Nothing else on the item, including a `value`, is read.
 * - Any SDK exception, malformed page, or runaway pagination becomes a closed failure code.
 *   The caught error is never inspected: no name, message, stack, cause, request ID, or
 *   metadata crosses this boundary, so nothing downstream can output it.
 *
 * Limitation, by design: the checker role's `apigateway:GET` on `/apikeys` cannot be limited
 * by IAM to `includeValues: false`. This module is what keeps values out, enforced by review
 * and by the boundary tests. It must not gain any output capability (logging, SNS) or export
 * the client, `send`, raw responses, or errors.
 */
import { APIGatewayClient, GetApiKeysCommand } from '@aws-sdk/client-api-gateway';
import { KeyMetadataReadResult, KeySlotLabel, MalformedKeySlot, MalformedKeyReason, ObservedKeySlot } from './records';

const PAGE_LIMIT = 500;
const MAX_PAGES = 100;
const OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Captured once: called on an untrusted value, it checks the Date internal slot itself and
// runs none of that value's code -- no getters, no Symbol.toStringTag, no Proxy traps.
const dateGetTime = Date.prototype.getTime;

type Own = { readonly present: false } | { readonly present: true; readonly isData: false } | { readonly present: true; readonly isData: true; readonly value: unknown };

/** Reads one own property without invoking a getter or walking the prototype chain. */
function own(target: object, key: string): Own {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) return { present: false };
  if (!('value' in descriptor)) return { present: true, isData: false };
  return { present: true, isData: true, value: descriptor.value };
}

function projectCreatedDate(raw: unknown): Date | undefined {
  if (typeof raw === 'string') {
    if (!OFFSET_TIMESTAMP_PATTERN.test(raw)) return undefined;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? undefined : new Date(ms);
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  let ms: number;
  try {
    ms = dateGetTime.call(raw);
  } catch {
    return undefined;
  }
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

type Projection =
  | { readonly kind: 'skip' }
  | { readonly kind: 'slot'; readonly slot: ObservedKeySlot }
  | { readonly kind: 'malformed'; readonly slot: MalformedKeySlot }
  | { readonly kind: 'invalid_page' };

function projectItem(item: unknown, expectedSlots: ReadonlyMap<string, KeySlotLabel>): Projection {
  if (item === null || typeof item !== 'object') return { kind: 'invalid_page' };
  const name = own(item, 'name');
  if (!name.present) return { kind: 'skip' };
  if (!name.isData) return { kind: 'invalid_page' };
  if (typeof name.value !== 'string') return { kind: 'skip' };
  const label = expectedSlots.get(name.value);
  if (!label) return { kind: 'skip' };
  // From here on, only the registry's label identifies this key.
  const { consumerId, slot } = label;
  const malformed = (reason: MalformedKeyReason): Projection => ({ kind: 'malformed', slot: { consumerId, slot, reason } });

  const enabled = own(item, 'enabled');
  const created = own(item, 'createdDate');
  if (!enabled.present || !enabled.isData || typeof enabled.value !== 'boolean') return malformed('invalid_key_metadata');
  if (created.present && !created.isData) return malformed('invalid_key_metadata');
  const createdDate = created.present && created.isData ? projectCreatedDate(created.value) : undefined;
  if (!createdDate) return malformed('missing_created_date');
  return { kind: 'slot', slot: { consumerId, slot, enabled: enabled.value, createdDate } };
}

/**
 * Lists every deployed key whose name exactly equals one of `expectedSlots`' names (each
 * derived from the registry), as fresh value-free records labeled with that entry's consumer
 * ID and slot. Completeness matters: any page that can't be read or decoded fails the whole
 * read rather than returning a partial list.
 */
export async function listKeyMetadata(expectedSlots: ReadonlyMap<string, KeySlotLabel>): Promise<KeyMetadataReadResult> {
  const client = new APIGatewayClient({});
  const slots: ObservedKeySlot[] = [];
  const malformed: MalformedKeySlot[] = [];
  const seenPositions = new Set<string>();
  let position: string | undefined;

  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) return { ok: false, failure: 'pagination_limit_exceeded' };
    let response: unknown;
    try {
      response = await client.send(new GetApiKeysCommand({ includeValues: false, limit: PAGE_LIMIT, position }));
    } catch {
      return { ok: false, failure: 'api_gateway_read_failed' };
    }

    try {
      if (response === null || typeof response !== 'object') return { ok: false, failure: 'invalid_metadata_page' };
      const items = own(response, 'items');
      const next = own(response, 'position');
      if ((items.present && !items.isData) || (next.present && !next.isData)) return { ok: false, failure: 'invalid_metadata_page' };
      const list = items.present && items.isData ? items.value : undefined;
      if (list !== undefined && !Array.isArray(list)) return { ok: false, failure: 'invalid_metadata_page' };
      for (let i = 0; i < (list?.length ?? 0); i++) {
        const entry = own(list as unknown[], String(i));
        if (!entry.present || !entry.isData) return { ok: false, failure: 'invalid_metadata_page' };
        const projected = projectItem(entry.value, expectedSlots);
        if (projected.kind === 'invalid_page') return { ok: false, failure: 'invalid_metadata_page' };
        if (projected.kind === 'slot') slots.push(projected.slot);
        if (projected.kind === 'malformed') malformed.push(projected.slot);
      }
      const nextPosition = next.present && next.isData ? next.value : undefined;
      if (nextPosition === undefined || nextPosition === null || nextPosition === '') break;
      if (typeof nextPosition !== 'string' || seenPositions.has(nextPosition)) return { ok: false, failure: 'invalid_metadata_page' };
      seenPositions.add(nextPosition);
      position = nextPosition;
    } catch {
      return { ok: false, failure: 'invalid_metadata_page' };
    }
  }
  return { ok: true, slots, malformed };
}
