# Formal Specification for the Declarative Polling Scheduler

This document provides a formal, normative specification for the backend declarative polling scheduler's public interface and externally observable operational semantics.

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
    Reinitializing --> Uninitialized : Reinitialization fails
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

SP           = ( " " / "\t" )+ ;
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

**See also:** The [Formal Model (Temporal Logic, Observable Only)](#formal-model-temporal-logic-observable-only) section provides a mathematical specification of how cron expressions are evaluated through the **Due(task, t)** predicate.

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

## Persistence Semantics & Overrides

### Override Resolution

When `initialize()` is called, the scheduler **MUST** compare provided registrations against persisted state and categorize each task as:

#### Classification Types

**New Task:** Exists in registrations but not in persisted state
- **Action:** Create new task state, apply first startup semantics

**Preserved Task:** Exists in both with identical configuration
- **Action:** Load existing state, continue normal scheduling

**Overridden Task:** Exists in both but with different configuration
- **Action:** Update persisted state with new configuration, reset execution timestamps

**Orphaned Task:** Exists in persisted state but not in registrations
- **Action:** Remove from persistence, cancel any scheduled execution

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
- Allow multiple concurrent calls to `initialize()`
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

## Formal Model (Temporal Logic, Observable Only)

This section gives a **Linear Temporal Logic (LTL)** model that specifies **only the externally observable behaviour** of the declarative polling scheduler using **propositional** atomic formulas over an **event‑driven trace**.

### Modelling Framework

* **Trace semantics:** Each trace position corresponds to an instant where ≥1 observable event occurs. Concurrency is linearised by total order (events that are “simultaneous” are ordered arbitrarily but consistently). Time bounds are background semantics only (not encoded in LTL).
* **Logic:** Standard future‑time LTL over the event propositions below. We use `G` (□), `F` (◊), `X` (next), `U` (until), `W` (weak until). Quantification “for all tasks x” is intended where noted.

### Atomic Propositions (per trace position)

* Global control: `IS` (InitStart), `IE` (InitEnd), `SS` (StopStart), `SE` (StopEnd), `Crash` (UnexpectedShutdown).
* For each task `x`:

  * `RS_x` — RunStart(x)
  * `REs_x` — RunEnd(x, success)
  * `REf_x` — RunEnd(x, failure)
  * Abbrev: `RE_x := REs_x ∨ REf_x`
* Environment/input predicates:

  * `Due_x` — cron schedule is due **now** for `x` (minute boundary in host‑clock semantics from the cron spec)
  * `Registered_x` — `x` is present in the **current** registration set (derived from the most recent `IE`)
  * `RetryEligible_x` — sufficient time has elapsed since the last `REf_x` for `x` to satisfy its `RetryDelay(x)`

> `Due_x` and `RetryEligible_x` are observational inputs derived from the cron layer and wall clock; they are not emitted events.

### Derived Predicates (macros)

**Registered\_x**
Set at `IE` to reflect membership of `x` in that `IE`’s registration set; holds until the next `IE` updates it. (Unaffected by `SS/SE/Crash`.)

**Active**
True iff there has been an `IE` and no `SS` nor `Crash` since that `IE`. (Intuitively: between `IE` and the next `SS` or `Crash`.)

**OpenPre\_x**
“An invocation of `x` is in flight **strictly before** the current position.” Defined inductively from events **up to the previous position**:

* Base (at the first position): `OpenPre_x := false`.
* Step: on advancing one position, `OpenPre_x := (OpenPre_x ∧ ¬RE_x) ∨ RS_x` evaluated using the **previous** step’s values.

> `OpenPre_x` lets us state properties that refer to runs that started earlier and have not yet ended *before* the current events are observed, without introducing past operators.

### LTL Safety Properties

For all tasks `x`:

**S1 — Per‑task non‑overlap**
`G( RS_x → (¬RS_x U (RE_x ∨ Crash)) )`
Once a run starts, no further `RS_x` may occur before a matching `RE_x` or `Crash`.

**S2 — Ends follow starts**
`G( RE_x → OpenPre_x )`
Every completion must correspond to a run that was already in flight before this position.

**S3 — Eligibility**
`G( RS_x → (Active ∧ Registered_x ∧ Due_x ∧ RetryEligible_x) )`
A start can occur only while active, registered, due, and not blocked by retry.

**S4a — Quiescence after StopEnd**
`G( SE → (¬RS_x W IE) )`
After `SE`, no new starts until re‑initialisation.

**S4b — StopEnd consistency**
`G( SE → (¬RE_x W IE) )`
After `SE`, no new ends until re‑initialisation.

**S5a — Crash quiescence**
`G( Crash → (¬RS_x W IE) )`
After a crash, no new starts until re‑initialisation.

**S5b — Crash consistency (no fabricated completions)**
`G( Crash → (¬RE_x W IE) )`
In any suffix beginning at a crash, completions must be preceded (in that suffix) by a start.

**S6 — No make‑up bursts (informative constraint)**
Between any two positions where `Due_x` holds (with no `Due_x` in between), there is **at most one** `RS_x` unless a failure occurs in the segment (in which case a retry may introduce an extra `RS_x` before the next `Due_x`).
*Note:* This constraint involves counting; exact formalisation is outside standard LTL. It can be enforced via an automaton or a trace‑checker macro.

**S8 — Initialization completes**
`G( IS → F IE )`
Initialization eventually completes.

**S7 — Stop completes**
`G( SS → F SE )`
Stop eventually completes.

### LTL Liveness Properties

For all tasks `x`:

**L1 — Stop terminates**
`G( SS → F SE )`

**L2 — Eventual execution under continuous due**
`G( Active ∧ Registered_x ∧ G F Due_x → G F RS_x )`

**L3 — Crash‑interrupted callbacks are restarted after next init**
`G( ( RS_x ∧ (¬RE_x U Crash) ) → F( IE ∧ F RS_x ) )`

### Fairness assumptions

This subsection records assumptions that cannot possibly be verified by the scheduler implementation.

**A1 — Starts eventually settle**
`G( RS_x → F( RE_x ∨ Crash ) )`
Every callback invocation (between `RS_x` and `RE_x`) completes in **finite** time unless pre‑empted by `Crash`. No uniform upper bound is required; the assumption only rules out infinite executions.

**F1 — Progress fairness.**
When the scheduler is **Active** and the process is not externally suspended or starved (e.g., not SIGSTOP'ed, no VM freeze, sufficient CPU), the polling loop makes progress and observable events continue to advance along the trace.

## Real-time bounds
 
This subsection gives formal timing requirements which are based on the model's vocabulary, but are **not** part of the LTL model. They are engineering targets for implementations. External pauses, OS scheduling, or heavy system load may widen the lag. They are expressed in prose to clarify the relationship between the LTL model and real‑world timing. 

**P1 — Scheduling‑lag.**
Whenever `Active ∧ Registered_x ∧ Due_x ∧ RetryEligible_x` holds, a corresponding `RS_x` **SHOULD** occur within about **1 minute** of that due instant.

**P2 — Post‑crash restart lag.**
If a run was in flight at `Crash`, after the next `IE` and once `Registered_x ∧ RetryEligible_x` holds, a new `RS_x` **SHOULD** occur within approximately **1 minute** (same bound as P1), provided no `SS` intervenes.

### Due Predicate (source of truth)

`Due_x` is true exactly at instants where task `x`’s POSIX cron expression matches the host’s calendar time for that minute boundary (see the Cron Language Specification). This predicate is provided by the cron layer; it is not an emitted event.

### Example Acceptable Traces (informative)

**Trace 1 — Normal operation**

```
IS
IE (task1 registered)
[Due_x]  RS_x
REs_x
[Due_x]  RS_x
REf_x
[Due_x]  RS_x   // RetryEligible_x now true
REs_x
```

**Trace 2 — Stop and restart**

```
IS
IE (task1 registered)
SS
SE                 // S8 requires no OpenPre_x here
// No RS_x until re‑init (S5)
IS
IE (task1 registered)
[Due_x]  RS_x
REs_x
```

**Trace 3 — Crash and restart**

```
IS
IE (task1 registered)
[Due_x]  RS_x
Crash              // S6a: no RS_x until next IE
IS
IE (task1 registered)
[Due_x]  RS_x      // L4: restart after re‑init
REs_x
```

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
