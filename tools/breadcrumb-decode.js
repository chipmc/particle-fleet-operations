'use strict';

/**
 * Decodes the `bc` (app breadcrumb) field carried by firmware `watchdog` events.
 *
 * Why this module exists
 * ----------------------
 * `bc` is the value of `lastWatchdogBreadcrumb`, a `uint8_t` in the firmware's
 * `MyPersistentData`. Two firmware generations write it with two different, unsynchronised
 * numbering schemes, and both are live in product 42131 simultaneously:
 *
 *   - Before GCC commit `75ad0a8` (2026-08-10), `State_Sleep.cpp` wrote RAW LITERALS 18, 19,
 *     20 and 21 that collided with enum values the main translation unit was already using
 *     for unrelated sites.
 *   - `75ad0a8` renumbered the sleep path to 22-28 to resolve that collision, but left the
 *     enum values it collided with unchanged, and added nothing to the payload that says
 *     which scheme produced a given value.
 *
 * The result is that `bc=21` from a Morrisville court unit and `bc=21` from a bench Boron
 * are not the same event, and the number alone cannot tell them apart.
 *
 * How the era is resolved
 * -----------------------
 * By LOG-FORMAT FINGERPRINT, never by a version string. `75ad0a8` made exactly two changes
 * that reach a reader: it renumbered the sleep breadcrumbs, and it added `osReason` to the
 * watchdog payload (`Generalized-Core-Counter.cpp`, the `publishWatchdogForensics()`
 * snprintf). Those shipped in the same commit, so `osReason` is present in a watchdog
 * payload if and only if that payload's build also carries the renumbered scheme. The
 * fingerprint is exact in both directions, and it is a property of the payload itself.
 *
 * `fw_version` / `fwVersion` is deliberately NOT consulted. It reports the Particle product
 * firmware version, which is a release label rather than evidence of the running build, and
 * this fleet has already been bitten by trusting it (GCC/WO-2026-08-31-004, where a device
 * reporting v23 was running working-tree code).
 *
 * Scope
 * -----
 * Containment only. This module makes the existing ambiguity RESOLVABLE by a reader. It does
 * not change what any breadcrumb means on either firmware tree, and it is not the fix for the
 * underlying "no owner of this namespace" problem, which is tracked separately.
 */

const BREADCRUMB_ERA_PRE_RENUMBER = 'pre-75ad0a8';
const BREADCRUMB_ERA_POST_RENUMBER = 'post-75ad0a8';

const BREADCRUMB_ERAS = new Set([
  BREADCRUMB_ERA_PRE_RENUMBER,
  BREADCRUMB_ERA_POST_RENUMBER,
]);

const GCC_MAIN = 'Generalized-Core-Counter.cpp';
const STATE_SLEEP = 'State_Sleep.cpp';
const STATE_CONNECT = 'State_Connect.cpp';

/**
 * Codes written from exactly one site, identically in both eras. Line numbers are omitted
 * here because they moved between the two trees while the meaning did not.
 */
const SHARED_CODES = {
  0: { label: 'none', site: null },
  1: { label: 'setup start', site: GCC_MAIN },
  2: { label: 'setup complete', site: GCC_MAIN },
  3: { label: 'sleep entry', site: STATE_SLEEP },
  4: { label: 'wake', site: STATE_SLEEP },
  5: { label: 'reporting', site: STATE_SLEEP },
  6: { label: 'connect requested', site: STATE_CONNECT },
  7: { label: 'cloud connected', site: STATE_CONNECT },
  8: { label: 'app watchdog reset', site: GCC_MAIN },
  9: { label: 'connectivity failsafe', site: GCC_MAIN },
  10: { label: 'connectivity failsafe hard', site: GCC_MAIN },
  11: { label: 'report queue start', site: GCC_MAIN },
  12: { label: 'report queue done', site: GCC_MAIN },
  13: { label: 'report ledger start', site: GCC_MAIN },
  14: { label: 'report ledger done', site: GCC_MAIN },
  15: { label: 'cloud loop enter', site: GCC_MAIN },
  16: { label: 'cloud loop exit', site: GCC_MAIN },
  17: { label: 'publish queue enter', site: GCC_MAIN },
};

/**
 * Codes 18-28, which differ by era. Verified against the two trees by enumerating every
 * `setAppBreadcrumb(` call site: GCC `48692fe` for the pre-renumber era, GCC `origin/main`
 * for the post-renumber era.
 *
 * In the pre-renumber era 18, 19 and 20 are each written from TWO sites with different
 * meanings, so the number genuinely cannot be resolved to one site. That residual ambiguity
 * is reported rather than guessed at. 21 is written only by `State_Sleep.cpp` in that era
 * (`BREADCRUMB_IDLE_ENTRY` is declared and named but never written), so it IS unambiguous.
 */
const ERA_CODES = {
  [BREADCRUMB_ERA_PRE_RENUMBER]: {
    18: {
      candidates: [
        { label: 'publish queue exit', site: `${GCC_MAIN}:1215` },
        {
          label: 'sleep-precondition gate',
          detail: 'awaiting modem teardown',
          site: `${STATE_SLEEP}:852`,
        },
      ],
    },
    19: {
      candidates: [
        { label: 'report post-ledger', site: `${GCC_MAIN}:1755` },
        { label: 'sleep gate done', site: `${STATE_SLEEP}:940` },
      ],
    },
    20: {
      candidates: [
        { label: 'report exit', site: `${GCC_MAIN}:1788` },
        { label: 'sleep config start', site: `${STATE_SLEEP}:1056/1125/1363/1377` },
      ],
    },
    21: {
      label: 'immediately before System.sleep()',
      site: `${STATE_SLEEP}:1078/1322/1371/1383`,
    },
    22: { isReachable: false, label: 'sleep gate start' },
    23: { isReachable: false, label: 'sleep gate done' },
    24: { isReachable: false, label: 'sleep config start' },
    25: { isReachable: false, label: 'sleep system call' },
    26: { isReachable: false, label: 'sleep serial drain done' },
    27: { isReachable: false, label: 'sleep diag flush done' },
    28: { isReachable: false, label: 'sleep call enter' },
  },
  [BREADCRUMB_ERA_POST_RENUMBER]: {
    18: { label: 'publish queue exit', site: `${GCC_MAIN}:1446` },
    19: { label: 'report post-ledger', site: `${GCC_MAIN}:1986` },
    20: { label: 'report exit', site: `${GCC_MAIN}:2019` },
    21: { isReachable: false, label: 'idle entry' },
    22: { label: 'sleep gate start', site: `${STATE_SLEEP}:862` },
    23: { label: 'sleep gate done', site: `${STATE_SLEEP}:950` },
    24: { label: 'sleep config start', site: `${STATE_SLEEP}:1066/1150/1390/1406` },
    25: { label: 'sleep system call', site: `${STATE_SLEEP}:1089/1347/1398/1412` },
    26: { label: 'sleep serial drain done', site: `${STATE_SLEEP}:1091/1349/1400/1414` },
    27: { label: 'sleep diag flush done', site: `${STATE_SLEEP}:1096` },
    28: { label: 'immediately before System.sleep()', site: `${STATE_SLEEP}:1098/1350/1401/1415` },
  },
};

/**
 * Resolves which numbering scheme produced a watchdog payload, from the payload alone.
 *
 * Returns the era plus the fingerprint it was read from, so a caller can show its working
 * rather than asking the reader to trust the answer.
 */
function resolveBreadcrumbEra(payload) {
  const hasOsReason = isPlainRecord(payload) &&
    Object.prototype.hasOwnProperty.call(payload, 'osReason') &&
    payload.osReason !== null &&
    payload.osReason !== undefined;

  return hasOsReason
    ? { era: BREADCRUMB_ERA_POST_RENUMBER, fingerprint: 'osReason present' }
    : { era: BREADCRUMB_ERA_PRE_RENUMBER, fingerprint: 'osReason absent' };
}

/**
 * Decodes one breadcrumb code against one era.
 *
 * `isAmbiguous` means the era itself cannot narrow the value to a single site — it is a
 * property of the firmware, not a shortcoming of the caller's inputs. `isReachable: false`
 * means no code in that era writes the value at all, which usually indicates retained state
 * carried across a firmware upgrade.
 */
function decodeBreadcrumb(code, era) {
  if (!BREADCRUMB_ERAS.has(era)) {
    throw new Error(`Unknown breadcrumb era: ${era}`);
  }
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    return null;
  }

  const eraEntry = ERA_CODES[era][code];
  const sharedEntry = SHARED_CODES[code];
  const entry = eraEntry || sharedEntry;

  if (!entry) {
    return {
      code,
      era,
      label: 'unknown',
      site: null,
      isAmbiguous: false,
      isReachable: false,
      candidates: [],
    };
  }

  if (entry.candidates) {
    return {
      code,
      era,
      label: entry.candidates.map(candidate => candidate.label).join(' OR '),
      site: null,
      isAmbiguous: true,
      isReachable: true,
      candidates: entry.candidates.map(candidate => ({ ...candidate })),
    };
  }

  return {
    code,
    era,
    label: entry.label,
    site: entry.site || null,
    isAmbiguous: false,
    isReachable: entry.isReachable !== false,
    candidates: [],
  };
}

/**
 * Resolves the era from a watchdog payload and decodes its `bc` in one step.
 * Returns null when the payload carries no breadcrumb, so callers can stay unconditional.
 */
function describeBreadcrumb(payload) {
  if (!isPlainRecord(payload)) return null;
  const code = toBreadcrumbCode(payload.bc);
  if (code === null) return null;

  const { era, fingerprint } = resolveBreadcrumbEra(payload);
  const decoded = decodeBreadcrumb(code, era);
  if (!decoded) return null;

  return { ...decoded, fingerprint };
}

/**
 * One-line rendering for a summary column. Always names the era, because a breadcrumb
 * number without its era is the ambiguity this module exists to close.
 */
function formatBreadcrumb(payload) {
  const decoded = describeBreadcrumb(payload);
  if (!decoded) return '';

  const prefix = `bc=${decoded.code} [${decoded.era}]`;
  if (decoded.isAmbiguous) {
    const sites = decoded.candidates
      .map(candidate => `${candidate.label} (${candidate.site})`)
      .join(' OR ');
    return `${prefix} AMBIGUOUS: ${sites}`;
  }
  if (!decoded.isReachable) {
    return `${prefix} ${decoded.label} - not written by this era, suspect retained state across upgrade`;
  }
  return decoded.site
    ? `${prefix} ${decoded.label} (${decoded.site})`
    : `${prefix} ${decoded.label}`;
}

function toBreadcrumbCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = {
  BREADCRUMB_ERAS,
  BREADCRUMB_ERA_POST_RENUMBER,
  BREADCRUMB_ERA_PRE_RENUMBER,
  decodeBreadcrumb,
  describeBreadcrumb,
  formatBreadcrumb,
  resolveBreadcrumbEra,
};
