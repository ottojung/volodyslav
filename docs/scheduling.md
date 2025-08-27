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

To avoid schedules that cannot be observed, the scheduler validates that a
cron expression's minimum interval is not shorter than the polling interval.

## Persistence and Recovery

Scheduler state is persisted through a runtime storage layer. The stored data
includes

- task definitions (identifier, schedule and retry interval)
- timestamps for the most recent attempt and outcome
- the scheduled time of any pending retry

All updates are written transactionally; a completed write represents the sole
source of truth. On restart the scheduler loads this state and requires the
application to supply matching task definitions. Executable logic is provided
anew at registration and is never persisted.

## Failure Handling and Retry

Each task defines a fixed delay before a failed run may be attempted again.
When a failure occurs the scheduler notes the time and computes the next
allowed attempt by adding the delay. Once the task succeeds the pending retry is
cleared. The strategy is intentionally simple to keep failure recovery
transparent and predictable.

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

