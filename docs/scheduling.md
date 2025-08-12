---
title: Backend Scheduling
description: High-level design of Volodyslav's backend scheduling and periodic tasks
---

## Overview

Volodyslav runs periodic background work via a lightweight, polling-based cron scheduler implemented in the backend. It schedules named tasks on cron expressions, executes them when due, and retries on failure with a configurable delay. All side effects are performed through capabilities.

## Components

- Cron API (`backend/src/cron/index.js`)
  - Factory `make(capabilities, { pollIntervalMs? })` returning a scheduler with: `schedule`, `cancel`, `cancelAll`, `getTasks`, `validate`.
  - Errors: `ScheduleDuplicateTaskError`, `ScheduleInvalidNameError`.
  - Parser utilities and `validate()` exported for one-off expression checks.

- Polling scheduler (`backend/src/cron/polling_scheduler.js`)
  - In-memory task registry with a single `setInterval` poller (default 10 minutes) that evaluates which tasks are due and runs them serially per task.
  - State tracked per task: last attempt/success/failure times, running flag, and pending retry time.
  - Failure sets `pendingRetryUntil = now + retryDelay`, and retries take precedence over cron until successful.
  - `getTasks()` provides a snapshot including an informative `modeHint` of "cron" | "retry" | "idle".

- Scheduling façade (`backend/src/schedule`)
  - `schedule/runner.js` bridges to the scheduler on capabilities.
  - `schedule/tasks.js` defines concrete tasks:
    - Hourly: diary audio processing and event log repo sync.
    - Daily (02:00): external `volodyslav-daily-tasks` program wrapper.
  - `schedule/index.js` exposes `make()` and a `runAllTasks(capabilities)` helper to run everything immediately.

- Daily tasks wrapper (`backend/src/schedule/daily_tasks.js`)
  - Calls `volodyslav-daily-tasks` via subprocess capability.
  - Logs stdout/stderr, maps missing executable into a `DailyTasksUnavailable` warning, and otherwise rethrows errors.

## Execution Flow

1. Server startup (`backend/src/server.js`) calls `scheduleAll(capabilities)` to register tasks:
   - every hour: "0 * * * *"
   - daily at 02:00: "0 2 * * *"
   - both with a retry delay of 5 minutes.
2. The polling scheduler ticks every `pollIntervalMs` and:
   - Skips running tasks.
   - If a retry is pending and due, runs the task in `retry` mode.
   - Else if a cron fire is due compared to the last successful run, runs in `cron` mode.
3. Success clears retry state; failure schedules the next retry.

## HTTP Endpoint

`GET /api/periodic?period=hour|hourly|day|daily` triggers the corresponding task immediately. Invalid or empty `period` yields HTTP 400.

## Logging

Structured logs are emitted for scheduler polls, task starts/successes/failures, and skips. The daily tasks wrapper also logs stdout/stderr line counts for traceability.

## Error Handling

- Duplicate task names throw `ScheduleDuplicateTaskError` and log a warning.
- Invalid names (empty/whitespace) throw `ScheduleInvalidNameError`.
- Missing external daily task executable is downgraded to a warning and the run is skipped.
