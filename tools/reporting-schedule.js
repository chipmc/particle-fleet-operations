'use strict';

const MILLISECONDS_PER_SECOND = 1000;
const ZONED_CLOCK_CACHE = new Map();

function computeNextScheduledApplicationReport({
  lastApplicationReportAt,
  reportingIntervalSeconds,
  openHour,
  closeHour,
  timeZone,
}) {
  const lastReportMs = new Date(lastApplicationReportAt || 0).getTime();
  if (Number.isNaN(lastReportMs) || !Number.isFinite(reportingIntervalSeconds) || reportingIntervalSeconds <= 0) {
    return null;
  }

  const candidateMs = lastReportMs + reportingIntervalSeconds * MILLISECONDS_PER_SECOND;
  if (!hasCompleteReportingWindow(openHour, closeHour, timeZone)) {
    return new Date(candidateMs).toISOString();
  }

  const clock = createZonedClock(timeZone.trim());
  if (!clock) return null;

  const candidateLocal = clock.partsAt(candidateMs);
  if (isWithinReportingWindow(candidateLocal, openHour, closeHour)) {
    return new Date(candidateMs).toISOString();
  }

  const openingDate = nextOpeningDate(candidateLocal, openHour, closeHour);
  const openingMs = clock.utcForLocal({
    ...openingDate,
    hour: openHour,
    minute: 0,
    second: 0,
  });
  return Number.isFinite(openingMs) ? new Date(openingMs).toISOString() : null;
}

function hasCompleteReportingWindow(openHour, closeHour, timeZone) {
  return Number.isInteger(openHour) && openHour >= 0 && openHour <= 23 &&
    Number.isInteger(closeHour) && closeHour >= 0 && closeHour <= 23 &&
    typeof timeZone === 'string' && Boolean(timeZone.trim());
}

function isWithinReportingWindow(local, openHour, closeHour) {
  if (openHour === closeHour) return true;

  const secondsOfDay = local.hour * 60 * 60 + local.minute * 60 + local.second;
  const openSeconds = openHour * 60 * 60;
  const closeSeconds = closeHour * 60 * 60;

  if (openHour < closeHour) {
    return secondsOfDay >= openSeconds && secondsOfDay <= closeSeconds;
  }
  return secondsOfDay >= openSeconds || secondsOfDay <= closeSeconds;
}

function nextOpeningDate(local, openHour, closeHour) {
  const secondsOfDay = local.hour * 60 * 60 + local.minute * 60 + local.second;
  const openSeconds = openHour * 60 * 60;
  if (openHour > closeHour || secondsOfDay < openSeconds) return pickDate(local);
  return addLocalDays(local, 1);
}

function addLocalDays(local, days) {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function pickDate(local) {
  return { year: local.year, month: local.month, day: local.day };
}

function createZonedClock(timeZone) {
  if (ZONED_CLOCK_CACHE.has(timeZone)) return ZONED_CLOCK_CACHE.get(timeZone);

  const ianaClock = createIanaClock(timeZone);
  const posixConfiguration = ianaClock ? null : parsePosixTimeZone(timeZone);
  const clock = ianaClock || (posixConfiguration ? createPosixClock(posixConfiguration) : null);
  ZONED_CLOCK_CACHE.set(timeZone, clock);
  return clock;
}

function createIanaClock(timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatter.format(new Date(0));
  } catch (_err) {
    return null;
  }

  const partsAt = (instantMs) => {
    const values = {};
    for (const part of formatter.formatToParts(new Date(instantMs))) {
      if (part.type !== 'literal') values[part.type] = Number(part.value);
    }
    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour,
      minute: values.minute,
      second: values.second,
    };
  };

  return {
    partsAt,
    utcForLocal: (local) => utcForLocalWithOffsets(local, partsAt, offsetsNearLocal(local, partsAt)),
  };
}

function offsetsNearLocal(local, partsAt) {
  const localAsUtcMs = localPartsAsUtc(local);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instantMs = localAsUtcMs + hours * 60 * 60 * MILLISECONDS_PER_SECOND;
    const parts = partsAt(instantMs);
    offsets.add(localPartsAsUtc(parts) - Math.floor(instantMs / 1000) * 1000);
  }
  return [...offsets];
}

function utcForLocalWithOffsets(local, partsAt, offsetsMs) {
  const targetLocalMs = localPartsAsUtc(local);
  const candidates = offsetsMs.map(offsetMs => targetLocalMs - offsetMs);
  const exact = candidates
    .filter(candidateMs => sameLocalParts(partsAt(candidateMs), local))
    .sort((left, right) => left - right);
  if (exact.length > 0) return exact[0];

  const afterGap = candidates.map(candidateMs => ({
    candidateMs,
    representedLocalMs: localPartsAsUtc(partsAt(candidateMs)),
  })).filter(candidate => candidate.representedLocalMs >= targetLocalMs)
    .sort((left, right) => left.representedLocalMs - right.representedLocalMs || left.candidateMs - right.candidateMs);
  return afterGap[0]?.candidateMs ?? NaN;
}

function sameLocalParts(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function localPartsAsUtc(local) {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour || 0, local.minute || 0, local.second || 0);
}

function parsePosixTimeZone(value) {
  const match = String(value).trim().match(
    /^(?:[A-Za-z]{3,}|<[^>]+>)([+-]?\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?)(?:(?:[A-Za-z]{3,}|<[^>]+>)([+-]?\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?)?(?:,([^,]+),([^,]+))?)?$/
  );
  if (!match) return null;

  const standardOffsetSeconds = -parsePosixOffsetSeconds(match[1]);
  if (!Number.isFinite(standardOffsetSeconds)) return null;
  if (!match[3] || !match[4]) return { standardOffsetSeconds };

  const startRule = parsePosixTransitionRule(match[3]);
  const endRule = parsePosixTransitionRule(match[4]);
  const daylightOffsetSeconds = match[2] === undefined
    ? standardOffsetSeconds + 60 * 60
    : -parsePosixOffsetSeconds(match[2]);
  if (!startRule || !endRule || !Number.isFinite(daylightOffsetSeconds)) return null;
  return { standardOffsetSeconds, daylightOffsetSeconds, startRule, endRule };
}

function parsePosixOffsetSeconds(value) {
  const match = String(value).match(/^([+-]?)(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (!match) return NaN;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 * 60 + Number(match[3] || 0) * 60 + Number(match[4] || 0));
}

function parsePosixTransitionRule(value) {
  const match = String(value).match(/^M(\d{1,2})\.(\d)\.(\d)(?:\/([+-]?\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?))?$/);
  if (!match) return null;
  const month = Number(match[1]);
  const week = Number(match[2]);
  const weekday = Number(match[3]);
  const seconds = match[4] === undefined ? 2 * 60 * 60 : parseSignedClockSeconds(match[4]);
  if (month < 1 || month > 12 || week < 1 || week > 5 || weekday < 0 || weekday > 6 || !Number.isFinite(seconds)) {
    return null;
  }
  return { month, week, weekday, seconds };
}

function parseSignedClockSeconds(value) {
  const match = String(value).match(/^([+-]?)(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (!match) return NaN;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 * 60 + Number(match[3] || 0) * 60 + Number(match[4] || 0));
}

function createPosixClock(configuration) {
  const offsetAt = (instantMs) => posixOffsetAt(instantMs, configuration);
  const partsAt = (instantMs) => {
    const local = new Date(instantMs + offsetAt(instantMs) * MILLISECONDS_PER_SECOND);
    return {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      second: local.getUTCSeconds(),
    };
  };
  const offsetsMs = [configuration.standardOffsetSeconds * MILLISECONDS_PER_SECOND];
  if (configuration.daylightOffsetSeconds !== undefined) {
    offsetsMs.push(configuration.daylightOffsetSeconds * MILLISECONDS_PER_SECOND);
  }
  return {
    partsAt,
    utcForLocal: (local) => utcForLocalWithOffsets(local, partsAt, offsetsMs),
  };
}

function posixOffsetAt(instantMs, configuration) {
  if (!configuration.startRule || !configuration.endRule) return configuration.standardOffsetSeconds;

  const approximateLocal = new Date(instantMs + configuration.standardOffsetSeconds * MILLISECONDS_PER_SECOND);
  const year = approximateLocal.getUTCFullYear();
  const startMs = posixTransitionUtc(year, configuration.startRule, configuration.standardOffsetSeconds);
  const endMs = posixTransitionUtc(year, configuration.endRule, configuration.daylightOffsetSeconds);
  const daylight = startMs < endMs
    ? instantMs >= startMs && instantMs < endMs
    : instantMs >= startMs || instantMs < endMs;
  return daylight ? configuration.daylightOffsetSeconds : configuration.standardOffsetSeconds;
}

function posixTransitionUtc(year, rule, offsetBeforeSeconds) {
  const firstWeekday = new Date(Date.UTC(year, rule.month - 1, 1)).getUTCDay();
  let day = 1 + ((rule.weekday - firstWeekday + 7) % 7) + (rule.week - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  if (day > daysInMonth) day -= 7;
  const localMs = Date.UTC(year, rule.month - 1, day) + rule.seconds * MILLISECONDS_PER_SECOND;
  return localMs - offsetBeforeSeconds * MILLISECONDS_PER_SECOND;
}

module.exports = {
  computeNextScheduledApplicationReport,
};
