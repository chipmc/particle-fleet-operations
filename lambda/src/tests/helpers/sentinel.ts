/**
 * Boundary assertions for WO-2026-09-30-001 design, Revision 5. Rather than watching output
 * channels, these inspect the exact value that crosses an architectural boundary: every own
 * property, enumerable or not, string- or symbol-keyed, at any depth, including property
 * names. Getters are reported, never invoked.
 */
export const VALUE_SENTINEL = 'SENTINEL-API-KEY-VALUE-must-never-cross';

export function findSentinel(root: unknown, sentinel: string = VALUE_SENTINEL): string[] {
  const hits: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.includes(sentinel)) hits.push(path);
      return;
    }
    if (typeof value === 'symbol') {
      if (String(value.description).includes(sentinel)) hits.push(`${path} (symbol)`);
      return;
    }
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    for (const key of Reflect.ownKeys(value as object)) {
      const label = typeof key === 'symbol' ? `[${String(key.description)}]` : key;
      if (String(label).includes(sentinel)) hits.push(`${path}.${String(label)} (key)`);
      const descriptor = Object.getOwnPropertyDescriptor(value as object, key)!;
      if ('value' in descriptor) visit(descriptor.value, `${path}.${String(label)}`);
      // V8 defines an Error's `stack` as an own native accessor. Its text is what gets
      // logged, so read it and search it; any other accessor is reported unread.
      else if (value instanceof Error && key === 'stack') visit((value as Error).stack, `${path}.stack`);
      else hits.push(`${path}.${String(label)} (accessor present)`);
    }
  };
  visit(root, '$');
  return hits;
}

/** Own keys of a record, enumerable or not, including symbols. */
export function allOwnKeys(value: object): (string | symbol)[] {
  return Reflect.ownKeys(value);
}
