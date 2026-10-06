/**
 * Daily ingestion API key rotation checker entry point (EventBridge, 09:00 UTC). Alert-only:
 * it never disables, deletes, or blocks anything. See
 * docs/work-orders/WO-2026-09-30-001-design.md (Revisions 3 and 5).
 *
 * Composition only: read value-free key metadata through the adapter, evaluate it in the
 * core, publish each event and one run summary through the typed emitters. A run that can't
 * read metadata, can't publish, or isn't configured still reports what it can (a fixed
 * checker-failure event and summary), then throws one fixed local error so the Errors alarm
 * fires. Nothing caught here is ever inspected or rethrown, so Lambda's own error logging
 * has no upstream object to serialize.
 */
import consumerRegistry from '../../../config/ingestion-consumers.json';
import { listKeyMetadata } from './metadata-adapter';
import { CheckerConsumer, evaluateRotation, expectedKeySlots } from './rotation-core';
import { createAlertPublisher, logRunSummary } from './emitters';
import { CheckerFailure, RotationEvent, RotationRunSummary } from './records';

export const CHECKER_FAILED_MESSAGE = 'ingestion_api_key_rotation_check_failed';

/** Every registered consumer (active or not) from the bundled registry: each owns key names. */
function registeredConsumers(): CheckerConsumer[] {
  return (consumerRegistry.consumers as unknown as CheckerConsumer[]).map(({ id, apiKey }) => ({ id, apiKey }));
}

function summarize(now: Date, consumersChecked: number, events: readonly RotationEvent[], failure: CheckerFailure | null, publishFailures: number): RotationRunSummary {
  const overdue: string[] = [];
  const inconsistencies: RotationRunSummary['inconsistencies'][number][] = [];
  for (const e of events) {
    if (e.event === 'ingestion_api_key_rotation_overdue') overdue.push(e.consumerId);
    if (e.event === 'ingestion_api_key_rotation_inconsistency') inconsistencies.push({ consumerId: e.consumerId, reason: e.reason });
  }
  return { event: 'ingestion_api_key_rotation_check', checkedAt: now.toISOString(), consumersChecked, overdue, inconsistencies, failure, publishFailures };
}

async function runCheck(now: Date): Promise<boolean> {
  const consumers = registeredConsumers();
  const topicArn = process.env.ROTATION_ALERT_TOPIC_ARN;
  if (!topicArn) {
    logRunSummary(summarize(now, consumers.length, [], 'alert_topic_not_configured', 0));
    return false;
  }
  const publisher = createAlertPublisher(topicArn);

  const read = await listKeyMetadata(expectedKeySlots(consumers));
  if (!read.ok) {
    const outcome = await publisher.publish({ event: 'ingestion_api_key_rotation_checker_failed', failure: read.failure });
    logRunSummary(summarize(now, consumers.length, [], read.failure, outcome === 'publish_failed' ? 1 : 0));
    return false;
  }

  const events = evaluateRotation({ slots: read.slots, malformed: read.malformed, consumers, now });
  let publishFailures = 0;
  for (const event of events) {
    if ((await publisher.publish(event)) === 'publish_failed') publishFailures++;
  }
  logRunSummary(summarize(now, consumers.length, events, null, publishFailures));
  return publishFailures === 0;
}

export async function handler(): Promise<void> {
  let succeeded = false;
  try {
    succeeded = await runCheck(new Date());
  } catch {
    try {
      logRunSummary(summarize(new Date(), 0, [], 'unexpected_checker_error', 0));
    } catch {
      // Reporting is best effort here; the fixed error below still fires the alarm.
    }
  }
  if (!succeeded) throw new Error(CHECKER_FAILED_MESSAGE);
}
