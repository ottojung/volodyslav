# Formal Specification for the Declarative Polling Scheduler

**Version:** 1.0  
**Date:** 2024  
**Status:** Draft  

This document provides a formal, normative specification for the backend declarative polling scheduler's public interface and externally observable operational semantics.

## Table of Contents

1. [Introduction & Normative Language](#introduction--normative-language)
2. [Public API Surface](#public-api-surface)
3. [Operational Model & Time Semantics](#operational-model--time-semantics)
4. [Task Lifecycle](#task-lifecycle)
5. [Polling Lifecycle](#polling-lifecycle)
6. [Cron Language Specification](#cron-language-specification)
7. [Error Model](#error-model)
8. [Logging & Event Contract](#logging--event-contract)
9. [Persistence Semantics & Overrides](#persistence-semantics--overrides)
10. [Concurrency & Reentrancy](#concurrency--reentrancy)
11. [Determinism & Idempotency](#determinism--idempotency)
12. [Security & Performance Considerations](#security--performance-considerations)
13. [Conformance Appendix](#conformance-appendix)
14. [References & Glossary](#references--glossary)

---

## Introduction & Normative Language

This specification defines the externally observable behavior of the Declarative Polling Scheduler. It serves as:

- An integration contract for other teams
- A foundation for conformance testing
- A guide for independent re-implementations
- A behavioral lock for future refactors

### Normative Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119) and [RFC 8174](https://tools.ietf.org/html/rfc8174).

### Scope

**In scope:** Public interface (`initialize`, `stop`) and all externally observable behaviors including timing, persistence, logging, errors, and state transitions.

**Out of scope:** Internal module structure, private helper APIs, storage engine internals beyond externally visible effects.

---

## Public API Surface

The scheduler exposes exactly two public methods forming a minimal lifecycle interface.

### Scheduler Interface

A `Scheduler` instance **MUST** provide the following interface:

```javascript
interface Scheduler {
    initialize(registrations: Registration[]): Promise<void>
    stop(): Promise<void>
}
```

### Registration Format

A `Registration` **MUST** be a 4-tuple array with the following structure:

```javascript
type Registration = [
    string,     // Task name (unique identifier)
    string,     // Cron expression (POSIX format)
    Callback,   // Async function to execute
    Duration    // Retry delay duration
]
```

Where:
- **Task name** **MUST** be a non-empty string unique within the registration set
- **Cron expression** **MUST** be a valid POSIX 5-field cron expression
- **Callback** **MUST** be an async function `() => Promise<void>`
- **Duration** **MUST** be a non-negative time duration

---

## Operational Model & Time Semantics

### Time Provider and Granularity

The scheduler **MUST**:
- Use the host system's local clock as the authoritative time source
- Operate at minute-level granularity
- Evaluate task schedules at each minute boundary
- Consider a minute boundary to occur at the start of each minute (seconds = 0)

### Polling Behavior

The scheduler **MUST**:
- Poll for due tasks at regular intervals (implementation-defined frequency ≥ 1 minute)
- Execute all due tasks discovered during a poll
- Handle multiple due tasks in parallel with no ordering guarantees
- Continue polling as long as at least one task is scheduled
- Stop polling when no tasks are scheduled (optimization)

The scheduler **MUST**:
- Use the host system's local timezone for all time calculations
- Handle Daylight Saving Time (DST) transitions according to the host system's clock
- Consider a minute that does not exist during DST transitions (e.g., 2:30 AM during "spring forward") as automatically skipped
- Execute tasks **at most once** for minutes that occur twice during DST transitions (e.g., 2:30 AM during "fall back")
- Continue normal scheduling after DST transitions without requiring restart

**DST Transition Behavior:**
- **Spring Forward (Lost Hour):** Tasks scheduled during the skipped hour **MUST NOT** execute that day
- **Fall Back (Repeated Hour):** Tasks scheduled during the repeated hour **MUST** execute only during the first occurrence
- **Next Execution Calculation:** **MUST** correctly account for DST transitions when calculating future occurrences

### No Make-Up Execution Policy

**Critical Invariant:** When tasks miss multiple scheduled executions due to downtime, the scheduler **MUST** execute each task at most once when resuming, regardless of how many executions were missed.

**Rationale:** This prevents resource overwhelming and maintains predictable load patterns.

**Example:** A task scheduled `*/10 * * * *` (every 10 minutes) that misses 6 executions during a 1-hour outage **MUST** run only once when the scheduler resumes, not 6 times.

### Startup Semantics

#### First Startup (No Persisted State)

When no persisted state exists, the scheduler **MUST**:
1. Evaluate each task's cron expression against the current time
2. Execute immediately **only** those tasks whose cron expression **exactly matches** the current minute
3. Schedule all tasks for their next future occurrence

#### Subsequent Restarts (With Persisted State)

When persisted state exists, the scheduler **MUST**:
1. Load the previous execution state
2. Apply persistence override logic (see [Persistence Semantics](#persistence-semantics--overrides))
3. Continue normal scheduling based on last known attempt/success/failure times

---

## Scheduler Lifecycle

### Scheduler State Model

The scheduler **MUST** exist in exactly one of the following states:

```mermaid
stateDiagram-v2
    [*] --> Uninitialized
    Uninitialized --> Initializing : initialize() called
    Initializing --> Running : All tasks scheduled successfully
    Initializing --> Uninitialized : Initialization fails
    Running --> Stopping : stop() called
    Running --> Reinitializing : initialize() called again
    Reinitializing --> Running : Reinitialization succeeds
    Reinitializing --> Stopping : Reinitialization fails
    Stopping --> Stopped : All tasks complete, cleanup done
    Stopped --> [*] : Scheduler destroyed
```

### Scheduler State Definitions

- **Uninitialized:** Scheduler created but not yet initialized
- **Initializing:** Processing registrations, applying overrides, starting tasks
- **Running:** Normal operation with polling active and tasks scheduled
- **Reinitializing:** Re-processing registrations for idempotent initialization
- **Stopping:** Graceful shutdown in progress, waiting for running tasks
- **Stopped:** Cleanup complete, no active polling or tasks

### Scheduler State Transitions

#### Uninitialized to Initializing
**Guard:** `initialize(registrations)` called with valid input
**Action:** Begin validation, persistence override resolution
**Events:** `SchedulerInitializationStarted`

#### Initializing to Running
**Guard:** All registrations validated, overrides applied, tasks scheduled
**Action:** Start polling loop, mark scheduler as active
**Events:** `SchedulerInitializationCompleted`

#### Initializing to Uninitialized
**Guard:** Initialization fails due to validation or scheduling errors
**Action:** Clean up partial state, reset to uninitialized
**Events:** `SchedulerInitializationFailed`

#### Running to Reinitializing
**Guard:** `initialize(registrations)` called again (idempotent behavior)
**Action:** Compare new registrations with current state
**Events:** `SchedulerReinitializationStarted`

#### Running to Stopping
**Guard:** `stop()` called
**Action:** Stop accepting new polls, wait for running tasks
**Events:** `SchedulerStopRequested`

#### Stopping to Stopped
**Guard:** All running tasks complete, polling stopped
**Action:** Final cleanup, release resources
**Events:** `SchedulerStopped`

---

## Task Lifecycle

### Task State Model

Each task **MUST** exist in exactly one of the following states:

```mermaid
stateDiagram-v2
    [*] --> AwaitingRun
    AwaitingRun --> Running : Poll finds task due
    Running --> AwaitingRun : Task succeeds
    Running --> AwaitingRetry : Task fails
    AwaitingRetry --> Running : Retry time reached
    AwaitingRetry --> AwaitingRun : New cron occurrence supersedes retry
```

### Task State Definitions

- **AwaitingRun:** Task is waiting for its next cron occurrence
- **Running:** Task callback is currently executing
- **AwaitingRetry:** Task failed and is waiting for retry delay to pass

### State Transitions

#### From AwaitingRun to Running
**Guard:** Current time matches cron expression OR task has never run and cron expression matches current time exactly (first startup only)
**Action:** Invoke task callback, record attempt timestamp
**Events:** `TaskRunStarted`

#### From Running to AwaitingRun
**Guard:** Task callback completes successfully
**Action:** Record success timestamp, clear any pending retry
**Events:** `TaskRunCompleted`

#### From Running to AwaitingRetry
**Guard:** Task callback throws an error or rejects
**Action:** Record failure timestamp, calculate `pendingRetryUntil = now + retryDelay`
**Events:** `TaskRunFailed`

#### From AwaitingRetry to Running
**Guard:** Current time ≥ `pendingRetryUntil`
**Action:** Clear retry state, invoke task callback, record attempt timestamp
**Events:** `TaskRetryStarted`

#### From AwaitingRetry to AwaitingRun
**Guard:** New cron occurrence is due while task is in retry state
**Action:** Clear retry state, proceed with cron execution
**Events:** `TaskRetryPreempted`, `TaskRunStarted`

### Timestamp Management

The scheduler **MUST** maintain the following timestamps for each task:
- `lastAttemptAt`: Timestamp of most recent execution attempt (success or failure)
- `lastSuccessAt`: Timestamp of most recent successful execution (if any)
- `pendingRetryUntil`: Timestamp when retry is allowed (if in AwaitingRetry state)

---

## Polling Lifecycle

### Polling State Model

```mermaid
stateDiagram-v2
    [*] --> Inactive
    Inactive --> Active : First task scheduled
    Active --> Inactive : All tasks cancelled
    Active --> Stopping : Stop requested
    Stopping --> Inactive : All running tasks complete
```

### State Definitions

- **Inactive:** No polling loop running, no tasks scheduled
- **Active:** Polling loop running, evaluating scheduled tasks
- **Stopping:** Stop requested, waiting for running tasks to complete

### State Transitions

#### Inactive to Active
**Guard:** First task is scheduled via `schedule()` call
**Action:** Start polling loop
**Events:** `PollingStarted`

#### Active to Inactive
**Guard:** Last scheduled task is cancelled via `cancel()` call
**Action:** Stop polling loop
**Events:** `PollingStopped`

#### Active to Stopping
**Guard:** `stopLoop()` is called
**Action:** Mark scheduler as stopping, complete current poll cycle
**Events:** `PollingStopRequested`

#### Stopping to Inactive
**Guard:** All currently running tasks complete execution
**Action:** Final cleanup, release resources
**Events:** `PollingStopped`

---

## Cron Language Specification

The scheduler **MUST** accept strictly POSIX-compliant cron expressions as defined in IEEE Std 1003.1.

### Formal Grammar (EBNF)

```ebnf
cron-expr    = SP* minute SP+ hour SP+ day SP+ month SP+ weekday SP* ;
minute       = field-content ;
hour         = field-content ;
day          = field-content ;
month        = field-content ;
weekday      = field-content ;

field-content = "*" / element-list ;
element-list  = element ("," element)* ;
element       = number / range ;
range         = number "-" number ;
number        = DIGIT+ ;

SP           = ( " " / "\t" / "\n" / "\r" )+ ;
DIGIT        = "0" / "1" / "2" / "3" / "4" / "5" / "6" / "7" / "8" / "9" ;
```

### Field Ranges

- **minute**: 0–59
- **hour**: 0–23
- **day**: 1–31
- **month**: 1–12
- **weekday**: 0–6 (0 = Sunday, 6 = Saturday)

### Validation Rules

The scheduler **MUST** reject expressions that:
1. Do not contain exactly 5 fields separated by whitespace
2. Contain step syntax (`/N`)
3. Contain named values (`jan`, `mon`, `sunday`)
4. Contain macro expressions (`@daily`, `@hourly`)
5. Contain Quartz-specific tokens (`?`, `L`, `W`, `#`)
6. Contain weekday value `7` (use `0` for Sunday)
7. Contain wrap-around ranges where start > end
8. Contain values outside the valid range for each field
9. Contain non-decimal numeric formats (scientific notation, hex, signs)

### Day-of-Month/Day-of-Week Semantics

When both day-of-month (DOM) and day-of-week (DOW) are restricted (not `*`), the scheduler **MUST** execute the task if **either** condition matches (OR logic).

**Truth Table:**
| DOM | DOW | Logic | Example | Runs On |
|-----|-----|-------|---------|---------|
| `*` | `*` | AND | `0 0 * * *` | Every day at midnight |
| `*` | restricted | DOW only | `0 0 * * 1` | Every Monday at midnight |
| restricted | `*` | DOM only | `0 0 15 * *` | 15th of every month at midnight |
| restricted | restricted | OR | `0 0 1,15 * 1` | 1st, 15th, OR every Monday at midnight |

### Examples

**Valid expressions:**
- `0 0 * * *` - Daily at midnight
- `15 3 * * 1-5` - 3:15 AM on weekdays
- `0,30 * * * *` - Every 30 minutes
- `0 12 14 2 *` - Noon on February 14th

**Invalid expressions:**
- `*/15 * * * *` - Step syntax not allowed
- `0 0 * * mon` - Named values not allowed
- `@daily` - Macros not allowed
- `0 0 ? * *` - Quartz tokens not allowed

---

## Error Model

### Error Taxonomy

The scheduler **MUST** throw the following error types under the specified conditions:

#### Registration Validation Errors

**RegistrationsNotArrayError**
- **When:** `initialize()` called with non-array registrations parameter
- **Message:** `"Registrations must be an array"`
- **Details:** None

**RegistrationShapeError**
- **When:** Registration tuple has wrong length or invalid types
- **Message:** `"Invalid registration shape: expected [string, string, function, Duration]"`
- **Details:** `{ registrationIndex: number, received: any }`

**InvalidRegistrationError**
- **When:** Registration contains invalid data beyond shape issues
- **Message:** Varies based on specific validation failure
- **Details:** `{ field: string, value: any, reason: string }`

**ScheduleDuplicateTaskError**
- **When:** Multiple registrations have the same task name
- **Message:** `"Task with name \"<name>\" is already scheduled"`
- **Details:** `{ taskName: string }`

**CronExpressionInvalidError**
- **When:** Cron expression fails validation
- **Message:** `"Invalid cron expression \"<expr>\": <field> field <reason>"`
- **Details:** `{ expression: string, field: string, reason: string }`

**NegativeRetryDelayError**
- **When:** Retry delay is negative
- **Message:** `"Retry delay must be non-negative"`
- **Details:** `{ retryDelayMs: number }`

#### Scheduler Lifecycle Errors

**ScheduleTaskError**
- **When:** Task scheduling fails during `initialize()`
- **Message:** `"Failed to schedule task '<name>': <cause>"`
- **Details:** `{ name: string, cronExpression: string, cause: Error }`

**StopSchedulerError**
- **When:** Scheduler shutdown fails during `stop()`
- **Message:** `"Failed to stop scheduler: <cause>"`
- **Details:** `{ cause: Error }`

#### Cron Expression Parsing Errors

**InvalidCronExpressionError** (from expression module)
- **When:** Cron parsing fails due to syntax errors
- **Message:** `"Invalid cron expression \"<expr>\": <field> field <reason>"`
- **Details:** `{ expression: string, field: string, reason: string }`

**FieldParseError**
- **When:** Individual field parsing fails within cron expression
- **Message:** Specific to field validation failure
- **Details:** `{ fieldValue: string, fieldName: string }`

#### Cron Calculation Errors

**CronCalculationError**
- **When:** Date calculation fails for valid expression
- **Message:** `"Failed to calculate next occurrence: <cause>"`
- **Details:** `{ expression: string, currentTime: string, cause: Error }`

#### Task State Management Errors

**TaskTryDeserializeError** (Base class)
- **When:** Task state deserialization fails
- **Message:** Varies based on specific failure
- **Details:** `{ field: string, value: any, expectedType: string }`

**TaskMissingFieldError**
- **When:** Required field missing from persisted task state
- **Message:** `"Missing required field: <field>"`
- **Details:** `{ field: string }`

**TaskInvalidTypeError**
- **When:** Field has wrong type in persisted task state
- **Message:** `"Invalid type for field '<field>': expected <expected>, got <actual>"`
- **Details:** `{ field: string, value: any, expectedType: string, actualType: string }`

**TaskInvalidValueError**
- **When:** Field has invalid value in persisted task state
- **Message:** `"Invalid value for field '<field>': <reason>"`
- **Details:** `{ field: string, value: any, reason: string }`

**TaskInvalidStructureError**
- **When:** Task state structure is fundamentally invalid
- **Message:** Varies based on structural issue
- **Details:** `{ value: any }`

#### State Validation Errors

**TaskListMismatchError**
- **When:** Persisted tasks don't match current scheduler expectations
- **Message:** Varies based on mismatch type
- **Details:** `{ expected: any, actual: any }`

### Error Throwing Guarantees

The scheduler **MUST**:
- Throw validation errors synchronously during `initialize()` before any scheduling begins
- Wrap and re-throw unexpected errors with enhanced context
- Preserve original error information in `details.cause` when wrapping
- Use consistent error names and message formats across versions
- Include sufficient detail in error messages for debugging without exposing security-sensitive information

---

## Logging & Event Contract

### Stable Log Events

External systems **MAY** rely on the following log events and their required fields:

#### Scheduler Lifecycle Events

**SchedulerInitializationStarted**
- **Level:** DEBUG
- **Required Fields:** `totalRegistrations: number`

**SchedulerInitializationCompleted**
- **Level:** DEBUG
- **Required Fields:** `totalRegistrations: number`, `scheduledCount: number`, `skippedCount: number`

**SchedulerReinitializationStarted**
- **Level:** DEBUG
- **Required Fields:** None

**SchedulerStopRequested**
- **Level:** INFO
- **Required Fields:** None

**SchedulerStopped**
- **Level:** INFO
- **Required Fields:** None

#### Task Execution Events

**TaskRunStarted**
- **Level:** INFO
- **Required Fields:** `taskName: string`, `scheduledTime: string`, `actualTime: string`
- **Optional Fields:** `isRetry: boolean`

**TaskRunCompleted**
- **Level:** INFO
- **Required Fields:** `taskName: string`, `duration: number`, `success: true`

**TaskRunFailed**
- **Level:** WARNING
- **Required Fields:** `taskName: string`, `duration: number`, `success: false`, `error: string`
- **Optional Fields:** `nextRetryAt: string`

**TaskRetryStarted**
- **Level:** INFO
- **Required Fields:** `taskName: string`, `retryCount: number`

**TaskRetryPreempted**
- **Level:** INFO
- **Required Fields:** `taskName: string`, `reason: string`

#### Polling Events

**PollStarted**
- **Level:** DEBUG
- **Required Fields:** `pollTime: string`, `scheduledTaskCount: number`

**PollCompleted**
- **Level:** DEBUG
- **Required Fields:** `pollTime: string`, `tasksEvaluated: number`, `tasksExecuted: number`, `duration: number`

**PollingStarted**
- **Level:** DEBUG
- **Required Fields:** None

**PollingStopped**
- **Level:** DEBUG
- **Required Fields:** None

**PollingStopRequested**
- **Level:** DEBUG
- **Required Fields:** None

#### State Management Events

**TaskAdded**
- **Level:** INFO
- **Required Fields:** `taskName: string`, `cronExpression: string`, `retryDelayMs: number`

**TaskPreserved**
- **Level:** DEBUG
- **Required Fields:** `taskName: string`

**TaskOverridden**
- **Level:** INFO
- **Required Fields:** `taskName: string`, `changeType: string`, `oldState: object`, `newState: object`

**TaskOrphaned**
- **Level:** WARNING
- **Required Fields:** `taskName: string`, `lastExecutionTime: string`, `schedulerIdentifier: string`

#### Task Scheduling Events

**TaskScheduled**
- **Level:** DEBUG
- **Required Fields:** `taskName: string`, `cronExpression: string`, `retryDelayMs: number`

**TaskSkipped**
- **Level:** DEBUG
- **Required Fields:** `taskName: string`, `reason: string`

### Logging Guarantees

The scheduler **MUST**:
- Use consistent log event names across versions
- Include all required fields in their specified formats
- Use appropriate log levels (INFO for normal operations, WARNING for noteworthy conditions, DEBUG for detailed tracing)
- Generate events in causal order within each task's execution
- Use structured logging with machine-readable field names
- Include timestamps in ISO 8601 format for all time-related fields

---

## Persistence Semantics & Overrides

### Override Resolution

When `initialize()` is called, the scheduler **MUST** compare provided registrations against persisted state and categorize each task as:

#### Classification Types

**New Task:** Exists in registrations but not in persisted state
- **Action:** Create new task state, apply first startup semantics
- **Logging:** `TaskAdded` event

**Preserved Task:** Exists in both with identical configuration
- **Action:** Load existing state, continue normal scheduling
- **Logging:** `TaskPreserved` event

**Overridden Task:** Exists in both but with different configuration
- **Action:** Update persisted state with new configuration, reset execution timestamps
- **Logging:** `TaskOverridden` event with change details

**Orphaned Task:** Exists in persisted state but not in registrations
- **Action:** Remove from persistence, cancel any scheduled execution
- **Logging:** `TaskOrphaned` event

### Configuration Comparison

Tasks are considered **identical** if and only if:
1. Task name matches exactly
2. Cron expression string matches exactly
3. Retry delay duration matches exactly

Any difference in the above fields **MUST** trigger override behavior.

### Scheduler Identifier

The scheduler **MUST**:
- Generate a unique identifier on first initialization
- Use this identifier to detect orphaned tasks from other scheduler instances
- Include the identifier in all persisted task records

### Override Atomicity

All persistence override operations **MUST** be applied atomically. If any override operation fails, the scheduler **MUST** restore the previous state and throw a `ScheduleTaskError`.

---

## Concurrency & Reentrancy

### Parallel Execution

The scheduler **MUST**:
- Allow multiple tasks to execute concurrently
- Provide no ordering guarantees between simultaneous task executions
- Ensure each individual task executes serially (no concurrent executions of the same task)

### Reentrancy Protection

The scheduler **MUST**:
- Prevent multiple concurrent calls to `initialize()` on the same instance
- Allow `stop()` to be called during `initialize()`
- Ensure `stop()` waits for any in-progress `initialize()` to complete

### Resource Management

The scheduler **MUST**:
- Wait for all running tasks to complete before `stop()` returns
- Clean up polling resources regardless of task completion success
- Handle task execution failures without affecting other running tasks

---

## Determinism & Idempotency

### Deterministic Behavior

Given identical inputs, the scheduler **SHOULD** produce deterministic outputs:
- Same registrations + same persisted state + same wall clock time = same execution decisions
- Task execution order within a poll **MAY** vary but task selection **MUST** be deterministic

### Idempotency Guarantees

**`initialize()` Idempotency:**
- Multiple calls with identical registrations **MUST** have no additional effect
- Subsequent calls **MUST** not duplicate task scheduling
- Override detection **MUST** work correctly across multiple calls

**State Persistence Idempotency:**
- Writing the same state multiple times **MUST** be safe
- Partial failures **MUST** not corrupt state
- Recovery from crashes **MUST** restore consistent state

### Non-Deterministic Elements

The following behaviors **MAY** vary between equivalent runs:
- Exact execution timing within the same minute
- Task execution order within a single poll
- Specific polling interval timing (as long as all minutes are covered)

---

## Security & Performance Considerations

### Resource Limits

Implementations **SHOULD**:
- Limit the maximum number of concurrent task executions
- Implement reasonable timeouts for task execution
- Prevent memory leaks from long-running polling loops

### Input Validation

The scheduler **MUST**:
- Validate all inputs before processing
- Reject potentially dangerous cron expressions
- Sanitize task names for safe logging

### Error Handling

The scheduler **MUST**:
- Never expose internal implementation details in error messages
- Log security-relevant events (unauthorized access attempts, etc.)
- Handle resource exhaustion gracefully

---

## Conformance Appendix

### Testable Invariants

A conforming implementation **MUST** satisfy the following invariants:

1. **API Contract Invariants:**
   - `initialize([])` followed by `stop()` completes without error
   - `initialize(validRegs)` followed by `initialize(validRegs)` is idempotent
   - `stop()` on uninitialized scheduler completes without error

2. **Timing Invariants:**
   - Task scheduled for current minute executes within reasonable time
   - Task scheduled for future minute does not execute early
   - No make-up executions occur after extended downtime

3. **State Invariants:**
   - Task state persists across scheduler restarts
   - Override detection correctly identifies configuration changes
   - Orphaned tasks are properly cleaned up

4. **Error Invariants:**
   - Invalid registrations throw appropriate error types
   - Error messages contain required fields
   - Errors are thrown before any side effects occur

5. **Concurrency Invariants:**
   - Multiple tasks can execute simultaneously
   - Same task never executes concurrently with itself
   - `stop()` waits for all running tasks

### Test Methodology

Conformance testing **SHOULD** cover:
- All error conditions and error types
- Edge cases in cron expression evaluation
- State persistence and override scenarios
- Timing behavior under various conditions
- Concurrent execution scenarios

---

## References & Glossary

### References

1. [RFC 2119](https://tools.ietf.org/html/rfc2119) - Key words for use in RFCs to Indicate Requirement Levels
2. [RFC 8174](https://tools.ietf.org/html/rfc8174) - Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
3. [POSIX crontab](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html) - The Open Group Base Specifications
4. [POSIX Programmer's Manual](https://man7.org/linux/man-pages/man1/crontab.1p.html) - crontab(1p)

### Glossary

**Cron Expression:** A POSIX-compliant 5-field time specification string

**Declarative Configuration:** Task definitions provided as data rather than imperative commands

**Make-Up Execution:** Executing missed occurrences after downtime (explicitly NOT supported)

**Override:** Replacing persisted task configuration with new registration data

**Polling:** Periodic evaluation of task schedules to determine execution

**Registration:** A 4-tuple defining a scheduled task's identity, schedule, callback, and retry behavior

**Task:** A scheduled unit of work with associated execution state

**Temporal Granularity:** The minimum time resolution for scheduling (1 minute)

---

**Document Version:** 1.0  
**Last Updated:** 2024  
**Authors:** Generated for Volodyslav Project  
**Status:** Draft Specification