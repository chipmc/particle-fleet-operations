/**
 * Module-boundary rules for the rotation checker (WO-2026-09-30-001 design, Revision 5).
 * A finite set of dependency rules over the Lambda source, not an enumeration of output
 * channels: only the metadata adapter may reach API Gateway, the adapter has no output
 * capability and exports nothing but its one read, and the core and records import no SDK.
 *
 * KNOWN, ACCEPTED GAP (Codex round 4, R4-2; deferred by Chip, 2026-10-01): imports are
 * recognized by matching source text, so an import form the pattern doesn't recognize --
 * e.g. a bare side-effect import (`import '../module'`) -- is not checked against the
 * allowlist. Round 4 found no such import in the shipped code; this is a limit of the
 * verification layer, not of the checker. Tracked as separate future work: enforce the rule
 * from the TypeScript compiler's resolved module graph instead of a regex. Until then,
 * review new imports in rotation-checker/ by hand.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as adapterModule from '../../rotation-checker/metadata-adapter';

const SRC = path.join(__dirname, '..', '..');
const ADAPTER = 'rotation-checker/metadata-adapter.ts';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path.relative(SRC, full)] : [];
  });
}
const files = sourceFiles(SRC);
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const importSpecifiers = (rel: string) =>
  [...read(rel).matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);

test('the source walk sees the checker modules', () => {
  expect(files).toEqual(expect.arrayContaining([
    ADAPTER, 'rotation-checker/rotation-core.ts', 'rotation-checker/emitters.ts', 'rotation-checker/handler.ts', 'rotation-checker/records.ts',
  ]));
});

test('only the metadata adapter references the API Gateway SDK, by any import form', () => {
  expect(files.filter(f => read(f).includes('client-api-gateway'))).toEqual([ADAPTER]);
});

test('only the handler uses the metadata adapter', () => {
  expect(files.filter(f => importSpecifiers(f).some(s => s.endsWith('/metadata-adapter') || s === './metadata-adapter'))).toEqual(['rotation-checker/handler.ts']);
});

test('the adapter has no output capability and imports only the SDK and value-free records', () => {
  const source = read(ADAPTER);
  expect(importSpecifiers(ADAPTER).sort()).toEqual(['./records', '@aws-sdk/client-api-gateway']);
  expect(source).not.toMatch(/\bconsole\b|process\.|client-sns|require\s*\(|import\s*\(/);
});

test('the adapter exports only its one read capability, never a client, send, command, or raw data', () => {
  expect(Object.keys(adapterModule).sort()).toEqual(['listKeyMetadata']);
  expect(read(ADAPTER)).not.toMatch(/export\s+(const|let|var|class|default)\b/);
});

test('the value-free side imports only what it is explicitly allowed to (an allowlist, not a blocklist)', () => {
  // Anything else -- an SDK, fs, net, child_process, a logger -- is a new dependency of
  // value-free code and needs review, so it fails here by default.
  const ALLOWED_IMPORTS: Record<string, string[]> = {
    'rotation-checker/rotation-core.ts': ['../api-key-slots', './records'],
    'rotation-checker/records.ts': ['../api-key-slots'],
    'api-key-slots.ts': [],
  };
  for (const [rel, allowed] of Object.entries(ALLOWED_IMPORTS)) {
    expect({ module: rel, imports: [...new Set(importSpecifiers(rel))].sort() }).toEqual({ module: rel, imports: [...allowed].sort() });
    expect(read(rel)).not.toMatch(/\bconsole\b|process\.|globalThis|\brequire\s*\(|\bimport\s*\(/);
  }
});

test('Revision 6: the adapter never references a key id, and no checker module carries an ID field or ID pattern', () => {
  // The adapter is the only code that sees a raw response; it may read `name` (for the exact
  // registry lookup), `enabled` and `createdDate`, and nothing else. A key `id` is never read,
  // so no length or shape check on one can exist. Elsewhere, no ID-carrying field or ID
  // pattern may appear in the checker.
  expect(read(ADAPTER)).not.toMatch(/['"]id['"]|\.id\b|\bid\s*:/);
  for (const rel of files.filter(f => f.startsWith('rotation-checker/'))) {
    expect({ module: rel, idFields: read(rel).match(/\b(keyId|secondaryKeyId|apiKeyId|API_KEY_ID\w*)\b/g) ?? [] }).toEqual({ module: rel, idFields: [] });
  }
});

test('the handler and emitters reach AWS only through the adapter and the SNS publisher', () => {
  expect(importSpecifiers('rotation-checker/handler.ts').filter(s => s.startsWith('@aws-sdk'))).toEqual([]);
  expect(importSpecifiers('rotation-checker/emitters.ts').filter(s => s.startsWith('@aws-sdk'))).toEqual(['@aws-sdk/client-sns']);
});
