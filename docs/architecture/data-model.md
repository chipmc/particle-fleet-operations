# Engineering Handover – Particle Fleet Operations

## Executive Summary

Particle Fleet Operations is **not** intended to become a traditional telemetry database.

It is an **operational intelligence platform** whose purpose is to answer:

- What is happening now?
- What just happened?
- What should an operator do next?

The architecture therefore separates **facts** from **interpretation**.

The firmware owns facts about the device.

Fleet Operations owns interpretation across devices and over time.

This separation is one of the core architectural principles of the system.

---

# Current Architecture

The platform currently has four logical layers.

```
Particle Device
        │
        │ publishes immutable events
        ▼
Lambda Ingestion
        │
        ├──────────────► S3 Raw Archive
        │
        ▼
Event Normalization
        │
        ▼
Current State Projection (DynamoDB)
        │
        ▼
CLI / APIs / Future AI
```

The important point is that **Current State is a projection**, not the source of truth.

---

# S3 is the Source of Truth

Every Particle event received by the ingestion Lambda is already written to S3 before any processing occurs.

Nothing is overwritten.

Nothing is updated.

Nothing is deleted as part of normal operation.

Think of S3 as the immutable event journal.

```
Event
↓

S3 Object

Forever
```

If Fleet Operations is ever rebuilt from scratch, Current State can be regenerated entirely from S3.

That is intentional.

---

# CurrentState

CurrentState is intentionally denormalized.

Its purpose is fast operator queries.

Examples:

```
telemetry fleet

telemetry device

telemetry health

telemetry summary
```

These should never need to scan historical data.

CurrentState is therefore disposable.

If corrupted:

Delete it.

Replay S3.

Rebuild.

---

# Why CurrentState Exists

Operators almost always ask:

"What is the current condition of this device?"

not

"What happened six months ago?"

Therefore CurrentState is optimized for:

- current firmware
- battery
- cloud connectivity
- reporting schedule
- startup snapshot
- latest occupancy
- latest power state

not historical analysis.

---

# Where History Fits

This is the important part.

Historically we assumed S3 alone would be enough.

That assumption is beginning to break down.

Examples include:

- reset frequency
- reboot storms
- battery degradation
- modem instability
- recurring cloud failures
- watchdog trends
- anomaly detection
- future AI monitoring

All require event history.

---

# The Event History Problem

CurrentState intentionally forgets.

Firmware publishes:

```
Startup A

↓

Startup B

↓

Startup C
```

CurrentState eventually contains only:

```
Startup C
```

Everything else is gone.

For operators that is fine.

For health scoring it is not.

---

# We Do NOT Want Time-Series Telemetry

This is important.

We do **not** want every hourly occupancy report copied into DynamoDB forever.

500 devices

×

24 hours

×

365 days

becomes enormous while adding very little operational value.

Routine telemetry already exists permanently in S3.

---

# We DO Want Operational Events

Instead, we want an Event History table.

Think Git commits rather than file snapshots.

Examples:

```
BOOT

WATCHDOG_RESET

FIRMWARE_UPDATE

DEVICE_OFFLINE

DEVICE_RECOVERED

BATTERY_CRITICAL

LOW_POWER_POLICY_ENTERED

LOW_POWER_POLICY_EXITED

CONNECT_TIMEOUT

LEDGER_SYNC_FAILED

ANOMALY

OTA_START

OTA_COMPLETE
```

These are sparse.

Meaningful.

Operator-focused.

---

# Why ResetCount Exposed This

The recent firmware work uncovered the issue.

Firmware now publishes:

```
startup

resetCount
```

Daily cleanup may reset the counter.

CurrentState therefore eventually becomes:

```
resetCount = 0
```

A health algorithm reading only CurrentState concludes:

"No problem."

But the device may have rebooted:

```
14

times

today.
```

The information existed.

The projection discarded it.

---

# Health Should Use Events

Health should not derive trends from snapshots.

Instead:

```
CurrentState

+

Event History

↓

Health
```

Example:

```
Current battery = 82%

+

4 watchdog resets

+

3 modem failures

↓

Health = Degraded
```

---

# Event History Is Not Another CurrentState

This is a common misunderstanding.

We do NOT want:

```
Snapshot

Snapshot

Snapshot

Snapshot
```

We want:

```
BOOT

↓

WATCHDOG

↓

OFFLINE

↓

RECOVERED

↓

BATTERY_CRITICAL

↓

OTA_COMPLETE
```

Events.

Not snapshots.

---

# Proposed Long-Term Architecture

```
Particle

↓

Lambda

↓

S3
      │
      │ immutable
      ▼

Normalizer
      │
      ├────────► CurrentState
      │
      └────────► EventHistory

CurrentState

fast lookup

EventHistory

operational timeline

Health

consumes both

AI

consumes both
```

---

# Event Selection

Not every payload becomes an event.

Only meaningful state transitions.

Examples:

Generate events:

- startup changed
- firmware changed
- battery entered critical
- battery recovered
- offline
- online
- watchdog
- OTA
- anomaly

Do NOT generate events:

- hourly occupancy report
- battery 82 → 81
- temperature changed
- heap changed

Those remain in S3.

---

# Why Not Query S3 Directly?

Because operational queries become expensive.

Example:

```
How many watchdog resets

in the last 30 days?
```

Reading thousands of S3 objects repeatedly is inefficient.

A sparse event table makes those queries trivial.

---

# Architectural Principle

There are three levels of data.

## Level 1

Immutable Facts

```
S3
```

Never modified.

Replayable.

Forever.

---

## Level 2

Operational Projection

```
CurrentState
```

Fast.

Disposable.

One row per device.

---

## Level 3

Operational Memory

```
EventHistory
```

Sparse.

Append-only.

Operator-centric.

Supports health.

Supports AI.

Supports troubleshooting.

---

# Ownership

Firmware owns:

- runtime truth
- schedules
- startup
- reporting
- battery
- power
- connectivity

Fleet Operations owns:

- projections
- event generation
- cross-device correlation
- health
- anomaly detection
- operator workflows

Fleet Operations must never reinterpret firmware behavior.

---

# Immediate Recommendation

I would **not** redesign the platform immediately.

The next sequence should be:

1. Finish Device Status Schema v2 integration.
2. Complete the reporting contract work.
3. Introduce Event History as a first-class append-only operational log.
4. Build Health on top of **CurrentState + EventHistory**.
5. Build the future monitoring agent on those same two data sources.

That sequence preserves the clean architectural boundary you've established: firmware publishes authoritative facts, Fleet Operations projects current state for fast access, records meaningful operational events for memory, and derives higher-level intelligence from those two layers.
