---
title: Backend Scheduling
description: Design of the declarative polling scheduler
---

## Overview

The backend contains a scheduler that runs asynchronous tasks according to cron
expressions. Its design emphasises **declarative configuration**, durable
state and predictable recovery. The scheduler exposes a single lifecycle:
registration at start‑up followed by automatic execution; there are no
imperative APIs for adding or removing tasks while the process is running.

## Cron Expression Format (POSIX Only)

The scheduler accepts **strictly POSIX-compliant cron expressions** as defined in IEEE Std 1003.1 ([Open Group Base Specifications](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html)).

### Format Specification

Cron expressions consist of **exactly 5 time fields** separated by whitespace:

```
minute hour day-of-month month day-of-week
```

**Field Ranges:**
- **minute**: 0–59
- **hour**: 0–23  
- **day-of-month**: 1–31
- **month**: 1–12
- **day-of-week**: 0–6 (0 = Sunday, 6 = Saturday)

### Supported Syntax (POSIX Only)

Each field accepts:
- **`*`** – all valid values
- **Numbers** – single values (e.g., `15`, `3`)
- **Ranges** – inclusive ranges (e.g., `1-5`, `9-17`)
- **Lists** – comma-separated elements (e.g., `1,15,30`, `1-3,10,20-25`)

**Examples:**
- `15 3 * * 1-5` – 3:15 AM on weekdays
- `0 0 1,15 * 1` – midnight on 1st, 15th, and Mondays (DOM/DOW OR logic)
- `0 12 14 2 *` – noon on February 14th
- `0,30 * * * *` – every 30 minutes

### Rejected Non-POSIX Extensions

The scheduler **explicitly rejects** common cron extensions not in the POSIX standard:

- **Step syntax**: `*/15`, `0-30/5` (use explicit lists instead: `0,15,30,45`)
- **Names**: `mon`, `jan`, `sunday` (use numbers: `1`, `1`, `0`)
- **Macros**: `@hourly`, `@daily`, `@reboot` (use explicit expressions)
- **Quartz tokens**: `?`, `L`, `W`, `#` (not supported)
- **Extended ranges**: DOW `7` for Sunday (use `0`)
- **Wrap-around ranges**: `22-2` (use separate fields or lists)

### Day-of-Month/Day-of-Week Semantics

Following POSIX specification, when both day-of-month and day-of-week are specified (not wildcards), a job runs if **either** condition matches:

- `0 0 1,15 * 1` runs on the 1st, 15th **OR** any Monday
- `0 0 * * 1` runs **only** on Mondays  
- `0 0 15 * *` runs **only** on the 15th of each month

For authoritative documentation, refer to:
- [The Open Group Base Specifications: crontab](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html)
- [POSIX Programmer's Manual: crontab(1p)](https://man7.org/linux/man-pages/man1/crontab.1p.html)

## Design Goals

- **Declarative configuration** – the set of tasks is described entirely by the
  registrations provided during initialisation.
- **Deterministic behaviour** – persisted runtime state must match the declared
  tasks exactly or the scheduler refuses to start.
- **Durable state** – task definitions and minimal execution history are stored
  atomically so a restart continues from the last known state.
- **Minimal surface area** – the scheduler exposes only initialisation and stop
  operations, keeping scheduling logic encapsulated.

## Declarative Model

The scheduler follows a declarative philosophy: every task is described by
data rather than by issuing commands. This treats scheduling as configuration,
not control flow, making the desired state explicit and auditable. A task
definition consists of an identifier, a cron‑style schedule, executable logic
and a retry interval. All definitions are supplied during start‑up and
represent the complete list of tasks the application expects to exist.

At initialisation the scheduler loads the previously persisted definitions and
checks that they exactly match the ones provided at start‑up. If the sets differ
the scheduler refuses to run. This validation eliminates configuration drift and
ensures that a process restart reproduces the intended schedule.

The declarative approach has several implications:

1. **Static task set** – the lifetime of the process is bound to the tasks
   defined at start‑up. Adding, removing or modifying a task requires changing
   the definitions and restarting the scheduler, which keeps runtime state
   predictable.
2. **Reproducibility** – given the same declarations and persisted state, the
   scheduler behaves deterministically across hosts and restarts.
3. **State validation** – by verifying definitions on every start, stale tasks
   from previous deployments cannot linger unnoticed.

Because behaviour derives solely from declarations and stored state, the
scheduler exposes no API for ad‑hoc scheduling once it is running.

## Polling Execution

The scheduler uses a periodic polling loop to evaluate when tasks should run.
For each scheduled task the scheduler records the times of the latest attempt
and whether it succeeded or failed. A poll determines whether a task is due
either because a cron occurrence has arrived or a previously scheduled retry
time has passed. When both conditions hold, the earlier time determines the
next run. Due tasks execute asynchronously and their updated history is
persisted.

### No Make‑Up Execution Policy

**When a task misses multiple scheduled executions, it runs only once when the
scheduler resumes, not multiple times to "catch up" for missed runs.** This
behaviour is intentional and provides several benefits:

- **Resource protection** – prevents overwhelming the system with a burst of
  overdue tasks after extended downtime.
- **Predictable load** – execution frequency remains consistent with the
  declared schedule rather than creating unpredictable spikes.
- **Simplified state** – avoids complex tracking of historical missed
  executions and their individual retry states.
- **Deterministic behaviour** – the same schedule produces the same execution
  pattern regardless of when the scheduler was offline.

For example, if a task scheduled to run every 2 hours misses 6 executions due
to a 12‑hour system outage, it will execute once when the scheduler restarts
rather than attempting to run 6 times in succession. The task then continues
on its normal 2‑hour schedule from that point forward.

This design aligns with the scheduler's declarative philosophy: tasks follow
their ongoing schedule rather than trying to reconstruct past execution
history.

To avoid schedules that cannot be observed, the scheduler validates that a
cron expression's minimum interval is not shorter than the polling interval.

## Persistence and Recovery

Scheduler state is persisted through a runtime storage layer. 
On restart the scheduler loads this state and requires the
application to supply matching task definitions.
The actual callbacks are provided anew at registration and are not persisted.

## Failure Handling and Retry

Each task defines a fixed delay before a failed run may be attempted again.
When a failure occurs the scheduler notes the time and computes the next
allowed attempt by adding the delay. Once the task succeeds the pending retry is
cleared. The strategy is intentionally simple to keep failure recovery
transparent and predictable.

## Startup Semantics

The scheduler follows specific rules for task execution during the very first startup when no persisted state exists:

### First Startup Behavior

**Tasks execute immediately only if their cron expression exactly matches the current time at startup.** This prevents overwhelming the system with all tasks executing simultaneously while still honoring tasks that are genuinely scheduled to run at that moment.

#### Examples

- **Should execute**: If the scheduler starts at 15:30 on a Tuesday and a task is scheduled with `30 15 * * 2` (15:30 on Tuesday), the task will execute immediately.
- **Should not execute**: If the scheduler starts at 15:30 on a Tuesday and a task is scheduled with `20 15 * * 2` (15:20 on Tuesday), the task will wait until its next scheduled time.

### Subsequent Startup Behavior

After the first startup, the scheduler loads persisted execution history and continues normal scheduling based on the last known state. No special first-startup logic applies to subsequent restarts.

## Limitations and Tradeoffs

1. **Local time only** – scheduling uses the host's clock without timezone
   abstraction.
2. **No disabled state** – a task exists only while it is registered.
3. **Fixed retry delay** – there is no exponential backoff or jitter.
4. **Frequency guard** – cron expressions that would fire more frequently than
   the polling loop can observe are rejected.
5. **Immediate persistence** – state is written after each mutation which can
   increase I/O but ensures durability.
6. **No callback persistence** – executable logic is provided anew at every
   start; only task identity and history are stored.
7. **Advanced features omitted** – priority scheduling, metrics, dynamic
   registration, time‑zone handling and similar complexities are intentionally
   excluded to keep the scheduler simple and predictable.

