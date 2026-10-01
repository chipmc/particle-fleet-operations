/**
 * The checker's only output paths (WO-2026-09-30-001 design, Revision 5): one SNS alert per
 * `RotationEvent`, one structured log line per `RotationRunSummary`. Each accepts only its
 * closed record type and serializes it by naming every field explicitly -- no spread, no
 * generic stringify of whatever it was handed, no error formatting. A publish failure is
 * reduced to a fixed code; the SNS error itself is never read.
 */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { KeySummary, RotationEvent, RotationRunSummary } from './records';

export type PublishOutcome = 'published' | 'publish_failed';

export interface AlertPublisher {
  publish(event: RotationEvent): Promise<PublishOutcome>;
}

function keyFields(keys: readonly KeySummary[]): { slot: string; enabled: boolean }[] {
  return keys.map(k => ({ slot: k.slot, enabled: k.enabled }));
}

/** Fresh plain object holding exactly the event's declared fields. */
export function eventFields(event: RotationEvent): Record<string, unknown> {
  switch (event.event) {
    case 'ingestion_api_key_rotation_overdue':
      return {
        event: event.event,
        consumerId: event.consumerId,
        phase: event.phase,
        secondarySlot: event.secondarySlot,
        secondaryKeyCreatedDate: event.secondaryKeyCreatedDate,
        alertTargetAt: event.alertTargetAt,
        daysOverdue: event.daysOverdue,
        keys: keyFields(event.keys),
      };
    case 'ingestion_api_key_rotation_inconsistency':
      return {
        event: event.event,
        consumerId: event.consumerId,
        reason: event.reason,
        keyCount: event.keyCount,
        keys: keyFields(event.keys),
      };
    case 'ingestion_api_key_rotation_checker_failed':
      return { event: event.event, failure: event.failure };
  }
}

function subjectFor(event: RotationEvent): string {
  switch (event.event) {
    case 'ingestion_api_key_rotation_overdue':
      return `Ingestion API key rotation overdue: ${event.consumerId}`;
    case 'ingestion_api_key_rotation_inconsistency':
      return `Ingestion API key rotation inconsistency: ${event.consumerId}`;
    case 'ingestion_api_key_rotation_checker_failed':
      return 'Ingestion API key rotation checker failed';
  }
}

export function createAlertPublisher(topicArn: string): AlertPublisher {
  // One attempt per alert: the design's "no retries". A retried publish after an ambiguous
  // failure could deliver the same day's alert twice; a failed one fires the Errors alarm.
  const sns = new SNSClient({ maxAttempts: 1 });
  return {
    async publish(event: RotationEvent): Promise<PublishOutcome> {
      try {
        await sns.send(new PublishCommand({
          TopicArn: topicArn,
          Subject: subjectFor(event),
          Message: JSON.stringify(eventFields(event), null, 2),
        }));
        return 'published';
      } catch {
        return 'publish_failed';
      }
    },
  };
}

/** Fresh plain object holding exactly the summary's declared fields. */
export function summaryFields(summary: RotationRunSummary): Record<string, unknown> {
  return {
    event: summary.event,
    checkedAt: summary.checkedAt,
    consumersChecked: summary.consumersChecked,
    overdue: [...summary.overdue],
    inconsistencies: summary.inconsistencies.map(i => ({ consumerId: i.consumerId, reason: i.reason })),
    failure: summary.failure,
    publishFailures: summary.publishFailures,
  };
}

export function logRunSummary(summary: RotationRunSummary): void {
  console.info(JSON.stringify(summaryFields(summary)));
}
