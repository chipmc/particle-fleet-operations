Architecture

Unified Telemetry Planes

Plane 1 — Structured telemetry

Particle Device
→ Particle Cloud
→ Product Webhook
→ AWS API Gateway
→ Lambda (TypeScript)
  → Storage: S3
  → Index: DynamoDB
→ S3
→ DynamoDB

Events:

* Ubidots-Sensor-Hook-v1

⸻

Plane 2 — Forensic cloud events

Particle Device
→ Product Webhook
→ API Gateway
→ Lambda (TypeScript)
  → Storage: S3
  → Index: DynamoDB
→ S3
→ DynamoDB

Events:

* watchdog
* status

⸻

Plane 3 — Raw serial telemetry

Particle Device
→ USB Serial
→ Raspberry Pi Forwarder
→ API Gateway
→ Lambda (TypeScript)
  → Storage: S3
  → Index: DynamoDB
→ S3
→ DynamoDB

Events:

* serialLog
* SERIAL_CONNECTED
* SERIAL_DISCONNECTED
* SERIAL_MISSING
* LOG

⸻

Storage

S3

Immutable raw event objects and verified DynamoDB index snapshots.

Retention for the existing raw event objects is unchanged and outside this
work order. DynamoDB index snapshots expire after 730 days, matching Ubidots;
revisit that starting policy after one year of real usage.

Path:

particle-events/YYYY-MM-DD/{eventName}/{deviceId}/timestamp.json

DynamoDB index archive path:

dynamodb-index-archive/v1/event_date=YYYY-MM-DD/device_bucket=0..f/run_id=.../part-NNNNN.jsonl.gz

Index snapshots are gzip JSON Lines with a per-shard manifest. A monthly
Step Functions workflow copies rows older than 60 days, reads each object back,
verifies checksums and item digests, and rereads the source rows before any
eventual deletion. Phase 1 has deletion disabled and its IAM role has no
`dynamodb:DeleteItem` permission.

⸻

DynamoDB

Fast indexed retrieval.

Partition:

deviceId

Sort:

eventTime

Purpose:

timeline reconstruction

The API and CLI query only DynamoDB. There is currently no Athena table,
restore command, archive-aware API, or transparent hot/archive union. Archived
scans are deliberately deferred to a follow-up, so a query outside the hot
window must not be represented as a complete historical result.

### Archive Scale Limits

Two current limits are accepted at pre-production scale and require follow-up
before the archive backlog approaches them:

- A Step Functions Standard execution is limited to 25,000 history events. The
  current loop adds approximately 3 history events per 250-row scan page, so
  the theoretical page-loop ceiling is about 8,333 pages, or approximately
  2,083,250 rows. Allow operational headroom below that estimate because setup,
  completion, retries, and failure states also consume history events. The
  intended future fix is to split a large backlog across bounded executions.
  History exhaustion cannot run an in-workflow Catch, so an external
  EventBridge rule handles every `FAILED`, `TIMED_OUT`, or `ABORTED` execution
  and releases the lock only when that execution owns it.
- Step Functions state input/output is limited to 256 KiB. Codex reproduced a
  628,505-byte payload after 20 pages of 250 invalid-timestamp rows (5,000
  failures). Before failure accumulation can approach that shape, write detail
  to S3 and pass only a bounded report pointer and aggregate counts through the
  state machine.

Two further items are deliberately deferred rather than solved by this phase:

- **Exactly-once SNS delivery.** SNS is at-least-once; the claim-token state
  machine in `reconcileFailure` (`PENDING` → `SENDING` → `SENT`) prevents two
  *concurrent* callers from both publishing, but does not make an individual
  publish exactly-once against SNS's own retry behavior. See Finding 3 below
  for the specific residual window this leaves open.
- **Generalized/reusable workflow-outbox infrastructure.** The `ArchiveCoordination`
  table's claim/report/notification pattern is purpose-built for this one job.
  Extracting it into a shared outbox primitive for other workflows is future
  work, not something this phase's single-table design attempts.

### Archive Coordination Lock and Fencing

The monthly archive and any future workflow that mutates archived or
archiving rows coordinate through one DynamoDB table, `ArchiveCoordination`
(`lambda/src/archive-coordination.ts`), not an S3 object lock. Key items:

- `LOCK#monthly-archive` / `METADATA` — the lock itself. Acquiring it is a
  conditional `TransactWriteItems` that atomically increments a `fencingToken`
  (never a timestamp — DynamoDB single-item updates are linearizable, so this
  has no tie case). The token is never reset: releasing the lock clears
  `ownerExecutionArn`/`leaseExpiry` with `UpdateItem`, it never deletes the
  item, so a stale writer can never "start over" at a low token value.
- `RUN#<sha256(executionArn)>` / `METADATA` — one run's status, failure
  evidence (frozen on first write, never recomputed from a later caller's
  live input), report-write claim state, and notification-send claim state.

Every action (`PROCESS_PAGE`, `FINALIZE`) asserts the fencing token it was
issued is still current before doing any work. This is a precondition check
at the top of each action, not a continuous per-row transactional guard — the
residual gap is bounded by the lock's 24-hour lease, the same tradeoff any
lease-based distributed lock accepts.

**Forward-compatibility contract:** any future workflow that mutates
archived-or-archiving rows must acquire this same lock and honor its current
fencing token before performing a delete-and-reinsert rewrite. This binds
`WO-2026-08-28-003`'s not-yet-built historical-key backfill specifically —
that work must not invent its own coordination mechanism or assume it can run
concurrently with an archive execution.

Manual recovery when the lock is genuinely stuck (lease expired, owning
execution confirmed terminal) is `tools/archive-lock-release`, run under the
break-glass `ArchiveLockBreakGlassRole`; see "Break-Glass Recovery" in
`docs/operations.md` for the operator procedure.

### Findings

1. **Step Functions Standard execution history limit (25,000 events).**
  Bounds the practical page-loop ceiling to roughly 8,333 pages
  (~2,083,250 rows) at the current per-page history cost; see "Archive Scale
  Limits" above. Deferred: split a large backlog across bounded executions.
2. **Step Functions state input/output limit (256 KiB).** A large failure
  accumulation can exceed this; see "Archive Scale Limits" above. Mitigated
  today by writing failure detail to S3 and passing only a bounded pointer
  and aggregate counts through the state machine.
3. **SNS concurrent-in-flight duplicate risk.** The notification claim
  (`notification.state: PENDING → SENDING → SENT`) has a short lease
  (`CLAIM_LEASE_MINUTES = 5`). If a claim holder crashes mid-publish, a
  second caller can reclaim and publish again after the lease expires,
  producing at most one duplicate notification within roughly a 5-minute
  overlap window. This is accepted as self-evidently fine given this
  project's standing bias toward over-notifying rather than under-notifying
  operators about archive failures. If ever revisited, candidate fixes are a
  FIFO SNS topic with deduplication IDs, or a heartbeat/liveness mechanism
  that lets a live claim holder extend its own lease instead of relying on a
  fixed timeout.
4. **`CLAIM_HELD_ELSEWHERE` during a crash in the critical section.** Every
  archive failure fires both the in-workflow Catch path and the external
  EventBridge cleanup rule; whichever arrives second normally receives
  `CLAIM_HELD_ELSEWHERE` and returns without error, trusting the first
  caller to finish the report/lock-release/notification. If that first
  caller crashes *after* claiming but *before* finishing, and the second
  caller already saw `CLAIM_HELD_ELSEWHERE` before the claim's 5-minute
  lease expired, no invocation is left to retry — the run stays half-done
  until something else notices. This is a real, if narrow, gap: closing it
  properly means durable retry-scheduling beyond claim expiry, which is new
  coordination-module design, not archive-control.ts wiring, so it was
  deliberately left for a future round rather than expanded into this one.
  It is bounded in practice by the lock's 24-hour lease (after which
  break-glass recovery applies) and by `MonthlyArchiveMissedRunAlarm`, which
  pages operators if no completion is recorded during days 1-7 of the month
  regardless of which specific mechanism failed to finish.

  `REPORT_CONFLICT` specifically is *not* subject to this gap: `reportConflict`
  is a persisted, sticky flag on the run record, so `claimReporting`'s
  `CLAIM_HELD_ELSEWHERE` fallback checks it on every call and re-surfaces
  `REPORT_CONFLICT` for as long as the claim (and, after it expires, a fresh
  claim hitting the same underlying S3 mismatch) exists — not only for the one
  call that originally discovered it. `archive-control.ts` throws on that
  outcome, which surfaces through the Lambda's own async-invoke failure
  destination and the reconciliation DLQ alarm. (This was itself a bug caught
  by review: an earlier version of the throw-on-`REPORT_CONFLICT` fix reached
  only the first caller to observe the conflict, with every subsequent
  caller — the routine EventBridge dual-fire, or Lambda's own automatic async
  retry — silently seeing plain `CLAIM_HELD_ELSEWHERE` instead.) The residual
  gap above is specifically the *non*-conflict case: a claimant that crashes
  before ever reaching a conflict (or any other terminal outcome) to persist.

Phase 2A writes normalized/enriched attributes onto the same item. It does not
change the table keys, API Gateway, or S3 path/body format. Legacy Phase 1
attributes remain in place, while canonical fields provide stable plane and
event-type classification plus common telemetry metrics.

⸻

Lambda Architecture

Modular TypeScript implementation:

```
lambda/src/
├── handler.ts           # Main entry point
├── storage/
│   ├── s3.ts           # Raw event storage
│   └── dynamo.ts       # Event indexing
├── utils/
│   └── parse.ts        # Event parsing + Phase 2A normalization
└── types/
    └── index.ts        # Type definitions
```

**Current behavior (Phase 2A):**
- Authentication via webhook secret
- Raw event immutable storage in S3
- Fast indexed retrieval via DynamoDB
- Additive canonical normalization in `utils/parse.ts`
- Stable telemetry, forensic, and serial classification
- Common health/occupancy metric extraction
- Best-effort enrichment; normalization failure does not block ingestion
- Unknown event types remain accepted

The DynamoDB `deviceId`/`eventTime` key model is unchanged. Raw serial
`eventType` values are retained as `sourceEventType` when the canonical
`eventType` is written.

See `lambda/README.md` for development guide.

⸻

Production Traffic Pattern

**Burst traffic:** ~500 devices at top of each hour
**Reporting window:** 6:00am–10:00pm Eastern Time
**Normal frequency:** Once per hour per device

Expected application-report timing is schedule-aware. The canonical scheduler
uses the effective Ledger reporting interval, `openHour`/`closeHour` operating
window, and configured device timezone. If `last report + interval` is outside
the active window, the next report is the first valid slot in the next active
window. Device-local daylight-saving transitions are resolved from timezone
rules; operator workstation time and fixed UTC offsets are not scheduling
inputs.

Fleet presentation and attention consume this canonical timing. Connection and
transport allowances are applied after the scheduled slot to form the delivery
expectation. Health classification remains future work.

**Deployment timing:**
- Preferred: bottom of the hour (e.g., 7:30, 8:30, 9:30 ET)
- Reason: minimize risk during top-of-hour reporting bursts

**Validation requirements:**
1. Immediate post-deploy validation
2. Monitor next top-of-hour reporting cycle
3. Verify burst handling maintained
