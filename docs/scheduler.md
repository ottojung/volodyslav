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

## Design Goals

- **Declarative configuration** – the set of tasks is described entirely by the
  registrations provided during initialisation.
- **Adaptive configuration** – when declared tasks differ from persisted state,
  the scheduler automatically adapts by overriding disk data with the new
  declarations.
- **Durable state** – task definitions and minimal execution history are stored
  atomically so a restart continues from the last known state.
- **Minimal surface area** – the scheduler exposes only initialisation and stop
  operations, keeping scheduling logic encapsulated.

## Specification

This scheduler's implementation is fully specified in [docs/specs/scheduler.md](specs/scheduler.md).

## Declarative Model

The scheduler follows a declarative philosophy: every task is described by
data rather than by issuing commands. This treats scheduling as configuration,
not control flow, making the desired state explicit and auditable. A task
definition consists of an identifier, a cron‑style schedule, executable logic
and a retry interval. All definitions are supplied during start‑up and
represent the complete list of tasks the application expects to exist.

At initialisation the scheduler loads the previously persisted definitions and
compares them with the ones provided at start‑up. If the sets differ, the
scheduler logs the differences and overrides the persisted state with the new
registrations. This approach prioritizes the current declarations over stale
disk data, ensuring that the scheduler adapts to configuration changes without
manual intervention.

The declarative approach has several implications:

1. **Static task set** – the lifetime of the process is bound to the tasks
   defined at start‑up. Adding, removing or modifying a task requires changing
   the definitions and restarting the scheduler, which keeps runtime state
   predictable.
2. **Reproducibility** – given the same declarations and persisted state, the
   scheduler behaves deterministically across hosts and restarts.
3. **State override** – when task definitions change between deployments, the
   new definitions automatically override persisted state, with changes logged
   for transparency.

Because behaviour derives solely from declarations and stored state, the
scheduler exposes no API for ad‑hoc scheduling once it is running.

## Polling Execution

The scheduler uses a periodic polling loop to evaluate when tasks should run.
For each scheduled task the scheduler records the times of the latest attempt
and whether it succeeded or failed. A poll determines whether a task is due
either because a cron occurrence has arrived or a previously scheduled retry
time has passed. If so, the task's callback is invoked.

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

## Cron Expression Format (POSIX Only)

The scheduler accepts **strictly POSIX-compliant cron expressions** as defined in IEEE Std 1003.1 ([Open Group Base Specifications](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html)).

## Limitations and Tradeoffs

- **Local time only** – scheduling uses the host's clock without timezone
  abstraction.
- **No disabled state** – a task exists only while it is registered.
- **Fixed retry delay** – there is no exponential backoff or jitter.
- **Immediate persistence** – state is written after each mutation which can
  increase I/O but ensures durability.
- **No callback persistence** – executable logic is provided anew at every
  start; only task identity and history are stored.
- **Advanced features omitted** – priority scheduling, metrics, dynamic
  registration, time‑zone handling and similar complexities are intentionally
  excluded to keep the scheduler simple and predictable.

