'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  BREADCRUMB_ERA_POST_RENUMBER,
  BREADCRUMB_ERA_PRE_RENUMBER,
  decodeBreadcrumb,
  describeBreadcrumb,
  formatBreadcrumb,
  resolveBreadcrumbEra,
} = require('./breadcrumb-decode');
const { presentEvent } = require('./event-presentation');

/**
 * Real watchdog payloads pulled from S3 (`infrastack-rawparticlelogsbucket`) during the
 * 2026-09-03 -> 09-13 soak review. Recorded verbatim so the fixtures cannot drift toward
 * whatever the decoder happens to produce.
 *
 * The MAFC_1_BC18 / DEV_09_BC18 pair is the whole point of this module: identical `bc`,
 * identical `stage`, different firmware generation, different meaning.
 */
const MAFC_1_BC18 = {
  reset: 'watchdog', bc: 18, stage: 'connectivity', elapsed: 0, queue: 1, state: 4, connAge: 379808,
};
const MAFC_1_BC21 = {
  reset: 'watchdog', bc: 21, stage: 'sleep', elapsed: 27, queue: 1, state: 3, connAge: 0,
};
const DEV_09_BC18 = {
  reset: 'watchdog', osReason: 60, bc: 18, stage: 'connectivity', elapsed: 0, queue: 2, state: 4,
  connAge: 3597107,
};
const DEV_14_BC28 = {
  reset: 'watchdog', osReason: 60, bc: 28, stage: 'sleep', elapsed: 50, queue: 4, state: 3,
  connAge: 0,
};

test('era resolves from the payload fingerprint, not from a version string', () => {
  assert.deepEqual(resolveBreadcrumbEra(MAFC_1_BC18), {
    era: BREADCRUMB_ERA_PRE_RENUMBER,
    fingerprint: 'osReason absent',
  });
  assert.deepEqual(resolveBreadcrumbEra(DEV_09_BC18), {
    era: BREADCRUMB_ERA_POST_RENUMBER,
    fingerprint: 'osReason present',
  });
});

test('a fw_version claiming the other era does not move the answer', () => {
  // Guards the standing rule: never trust `fw=` alone (GCC/WO-2026-08-31-004).
  const lyingPayload = { ...MAFC_1_BC21, fw_version: 24, fwVersion: '24' };
  assert.equal(resolveBreadcrumbEra(lyingPayload).era, BREADCRUMB_ERA_PRE_RENUMBER);
});

test('a null or absent osReason reads as the pre-renumber era', () => {
  assert.equal(resolveBreadcrumbEra({ bc: 18, osReason: null }).era, BREADCRUMB_ERA_PRE_RENUMBER);
  assert.equal(resolveBreadcrumbEra({ bc: 18 }).era, BREADCRUMB_ERA_PRE_RENUMBER);
});

test('the same code decodes to different sites in the two eras', () => {
  const before = decodeBreadcrumb(18, BREADCRUMB_ERA_PRE_RENUMBER);
  const after = decodeBreadcrumb(18, BREADCRUMB_ERA_POST_RENUMBER);

  assert.equal(before.isAmbiguous, true);
  assert.equal(after.isAmbiguous, false);
  assert.equal(after.label, 'publish queue exit');
  assert.notEqual(before.label, after.label);
});

test('pre-renumber 18/19/20 report both candidate sites rather than guessing', () => {
  for (const code of [18, 19, 20]) {
    const decoded = decodeBreadcrumb(code, BREADCRUMB_ERA_PRE_RENUMBER);
    assert.equal(decoded.isAmbiguous, true, `bc=${code} must be reported ambiguous`);
    assert.equal(decoded.candidates.length, 2);
    assert.equal(decoded.site, null);
  }
});

test('pre-renumber 21 is unambiguous - only State_Sleep.cpp writes it in that tree', () => {
  const decoded = decodeBreadcrumb(21, BREADCRUMB_ERA_PRE_RENUMBER);
  assert.equal(decoded.isAmbiguous, false);
  assert.equal(decoded.label, 'immediately before System.sleep()');
  assert.match(decoded.site, /^State_Sleep\.cpp:/);
});

test('sleep-path codes 22-28 are unreachable before the renumber', () => {
  for (const code of [22, 23, 24, 25, 26, 27, 28]) {
    assert.equal(decodeBreadcrumb(code, BREADCRUMB_ERA_PRE_RENUMBER).isReachable, false);
  }
});

test('21 is unreachable after the renumber - declared but never written', () => {
  const decoded = decodeBreadcrumb(21, BREADCRUMB_ERA_POST_RENUMBER);
  assert.equal(decoded.isReachable, false);
  assert.equal(decoded.label, 'idle entry');
});

test('post-renumber 28 is the pre-System.sleep() site', () => {
  const decoded = decodeBreadcrumb(28, BREADCRUMB_ERA_POST_RENUMBER);
  assert.equal(decoded.isAmbiguous, false);
  assert.equal(decoded.label, 'immediately before System.sleep()');
});

test('codes shared by both eras decode identically', () => {
  for (const code of [0, 3, 6, 8, 17]) {
    const before = decodeBreadcrumb(code, BREADCRUMB_ERA_PRE_RENUMBER);
    const after = decodeBreadcrumb(code, BREADCRUMB_ERA_POST_RENUMBER);
    assert.equal(before.label, after.label, `bc=${code} must not change meaning across eras`);
  }
});

test('an unknown era is an error, not a silent default', () => {
  assert.throws(() => decodeBreadcrumb(18, 'v21'), /Unknown breadcrumb era/);
});

test('a non-integer or out-of-range code decodes to null', () => {
  assert.equal(decodeBreadcrumb(1.5, BREADCRUMB_ERA_PRE_RENUMBER), null);
  assert.equal(decodeBreadcrumb(-1, BREADCRUMB_ERA_PRE_RENUMBER), null);
  assert.equal(decodeBreadcrumb(256, BREADCRUMB_ERA_PRE_RENUMBER), null);
});

test('a code inside the byte range with no mapping is reported unknown, not dropped', () => {
  const decoded = decodeBreadcrumb(200, BREADCRUMB_ERA_POST_RENUMBER);
  assert.equal(decoded.label, 'unknown');
  assert.equal(decoded.isReachable, false);
});

test('describeBreadcrumb returns null when the payload carries no breadcrumb', () => {
  assert.equal(describeBreadcrumb({ reset: 'watchdog', osReason: 60 }), null);
  assert.equal(describeBreadcrumb(null), null);
  assert.equal(describeBreadcrumb('watchdog'), null);
});

test('a stringified bc is accepted', () => {
  assert.equal(describeBreadcrumb({ bc: '28', osReason: 60 }).code, 28);
});

test('the rendered line always names the era', () => {
  assert.match(formatBreadcrumb(MAFC_1_BC21), /\[pre-75ad0a8\]/);
  assert.match(formatBreadcrumb(DEV_14_BC28), /\[post-75ad0a8\]/);
});

test('real payloads: identical bc and stage, different meaning by era', () => {
  const morrisville = formatBreadcrumb(MAFC_1_BC18);
  const bench = formatBreadcrumb(DEV_09_BC18);

  assert.match(morrisville, /AMBIGUOUS/);
  assert.match(morrisville, /sleep-precondition gate/);
  assert.doesNotMatch(bench, /AMBIGUOUS/);
  assert.match(bench, /publish queue exit/);
  assert.notEqual(morrisville, bench);
});

test('the worst-case ambiguous summary survives the watch-mode line clamp', () => {
  // `watch` truncates rendered lines at WATCH_LINE_MAX_LENGTH (tools/telemetry). A clipped
  // ambiguous line would hide the second candidate site - i.e. hide exactly the ambiguity this
  // module exists to surface - so the constant is read from its source rather than mirrored.
  const telemetrySource = readFileSync(join(__dirname, 'telemetry'), 'utf8');
  const clampMatch = telemetrySource.match(/const WATCH_LINE_MAX_LENGTH = (\d+);/);
  assert.ok(clampMatch, 'WATCH_LINE_MAX_LENGTH not found in tools/telemetry');
  const clamp = Number(clampMatch[1]);

  for (const bc of [18, 19, 20]) {
    const presented = presentEvent({
      eventType: 'fault.watchdog',
      eventName: 'watchdog',
      eventTime: '2026-09-03T00:56:15.690Z',
      bc,
      stage: 'sleep',
    });
    assert.ok(
      presented.summary.length <= clamp,
      `bc=${bc} summary is ${presented.summary.length} chars, over the ${clamp} clamp`,
    );
    assert.match(presented.summary, /OR .*State_Sleep\.cpp:/);
  }
});

test('presentEvent annotates a watchdog summary with the decoded breadcrumb', () => {
  const presented = presentEvent({
    eventType: 'fault.watchdog',
    eventName: 'watchdog',
    eventTime: '2026-09-04T09:59:39.000Z',
    deviceId: 'e00fce686548d46c4b45e380',
    ...MAFC_1_BC21,
  });

  assert.equal(presented.kind, 'WATCHDOG');
  assert.match(presented.summary, /bc=21 \[pre-75ad0a8\] immediately before System\.sleep\(\)/);
});

test('presentEvent is unchanged for a watchdog event carrying no breadcrumb', () => {
  const presented = presentEvent({
    eventType: 'fault.watchdog',
    eventName: 'watchdog',
    eventTime: '2026-09-10T01:15:00.000Z',
    deviceId: 'e00fce6841443bcc0f3178e4',
  });

  assert.equal(presented.summary, 'Fault Watchdog');
});
