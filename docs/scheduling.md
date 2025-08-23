---
title: Backend Scheduling
description: High-level overview and intentional limitations of the polling scheduler
---

## High-Level Overview

The backend provides a minimal, capability-driven, polling cron scheduler. Its purpose is to execute named asynchronous tasks according to standard 5-field cron expressions (minute precision) and to retry failed executions after a configured delay until a successful run clears the retry state.

Key properties:
- **Declarative architecture**: task registrations must exactly match persisted runtime state. During initialization, the scheduler validates that all task names, cron expressions, and retry delays are identical to what was persisted. Any mismatch throws a `TaskListMismatchError` with detailed information about missing, extra, or differing tasks.
- Polling architecture: a single interval timer (eg. 10 minutes) evaluates all registered tasks for cron or retry eligibility.
- Persistence: complete runtime state (task definitions + execution history + retry metadata) is stored transactionally on disk using atomic operations. Loaded state after restart must be bit‑for‑bit semantically identical to the stored state at shutdown time (no silent drift, no resurrection of cancelled tasks).
- Recovery: tasks are restored from persisted records during startup; callbacks are reattached when the application re-registers them with identical parameters, preserving all execution history and retry state.
- Failure handling: each failure schedules a retry at (failureTime + retryDelay). When both a cron firing and a retry become due, the earlier scheduled time wins. Success clears failure & retry metadata.
- Concurrency: multiple due tasks run in parallel without limits.
- Validation: cron expressions are parsed & validated; scheduling forbids tasks whose theoretical minimum interval is shorter than the polling interval to avoid “impossible to observe” schedules.
- Logging: task lifecycle (start / success / failure / skips) is logged with `logInfo`; only internal scheduler errors surface with `logError` to keep noise low while still surfacing systemic faults.

## Declarative Task Registration

The scheduler enforces a **declarative model** where the application must re-register all tasks with identical parameters after every restart. This design ensures consistency between code and persisted runtime state.

### Key Aspects:

- **Exact Parameter Matching**: Task name, cron expression, and retry delay must be identical to persisted values
- **Validation on Initialization**: The scheduler compares all registrations against stored state during startup
- **TaskListMismatchError**: Thrown when there are discrepancies, providing detailed information about:
  - Missing tasks (present in persisted state but not in registrations)
  - Extra tasks (present in registrations but not in persisted state)  
  - Differing tasks (same name but different cron expression or retry delay)
- **Idempotent Operations**: Multiple initialization calls with identical registrations have no additional effect
- **First-time Setup**: Empty persisted state allows any non-empty registration set (initial deployment scenario)

This approach prevents configuration drift and ensures that the scheduler's runtime behavior exactly matches the application's intended task definitions.

## Limitations & Conscious Compromises

These are deliberate tradeoffs accepted for simplicity, clarity, and operational expectations:

1. Minute Precision Only: Expressions are standard 5-field (minute hour day-of-month month weekday) cron; no seconds field; sub-minute scheduling will be detected and rejected.
2. No Time Zone Abstraction: System local time is used directly. There is no explicit UTC or configurable timezone layer to reduce complexity. Daylight saving anomalies may shift perceived execution; this risk is accepted.
3. No Disabled State: A task is either present (scheduled) or absent (cancelled and persisted as removed). Feature flags or “pause” semantics are intentionally excluded.
4. Strict Persistence Semantics: Cancellations are persisted; cancelled tasks must not reappear after restart. No partial or lossy persistence is tolerated.
5. Per-Execution Commits: Each state change creates an individual git commit. Batching is intentionally omitted to preserve granular audit history.
6. Retry Strategy Simplicity: Single fixed delay per task. No exponential backoff, jitter, or capped retries; complexity deliberately avoided.
7. Expression Frequency Guard: Frequency validation rejects schedules that would require observation more frequently than the polling loop can guarantee. This imposes an upper bound on task cadence tied to the configured poll interval.
8. No Serialization of Callbacks: Functions are never persisted. Re-registration after restart is required to attach executable logic to restored task state. The declarative validation ensures that task definitions (name, cron expression, retry delay) match exactly between registrations and persisted state, preventing callback attachment to incorrect or modified task configurations.
9. Logging Severity Model: Using `logInfo` for both success and failure of task executions keeps the severity channel (`logError`) reserved for systemic scheduler malfunctions only.
10. Frequent state writes: The scheduler writes state changes to disk after each task execution using atomic transactions. This ensures durability and immediate persistence of execution history (success/failure times, retry metadata) but may impact performance due to high I/O overhead. The transactional approach prevents partial state corruption during system failures.

Anything beyond the above (priority queues, time zone parametrization, paused states, exponential backoff, task tagging, metrics export, etc.) is intentionally left out to keep the scheduler minimal and predictable.
