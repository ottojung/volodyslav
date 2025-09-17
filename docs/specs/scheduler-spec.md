# Specification for the Declarative Scheduler

This document provides a normative specification for the backend declarative scheduler's public interface and externally observable operational semantics.

---

## Introduction & Normative Language

This specification defines the externally observable behavior of the Declarative Scheduler. It serves as:

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

### Timely Behavior

The scheduler **MUST**:
- Handle multiple due tasks in parallel with no ordering guarantees

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
    Reinitializing --> Running : Reinitialization fails
    Stopping --> Stopped : All tasks complete, cleanup done
    Stopped --> Uninitialized : Scheduler destroyed
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

#### Reinitializing to Running

**Guard:** Subsequent call to `initialize(registrations)` returned.

**Action:** Either complete override resolution and continue, or fail keeping previous running state.

**Events:** `SchedulerReinitializationCompleted`

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

### Task State Transitions

#### From AwaitingRun to Running

**Guard:**

Either Case A or Case B.

- Case A:
  Current minute matches the cron expression AND the task has not been run this minute.

- Case B:
  There has been a time in the past when the cron expression matched, but the scheduler missed it, except if the task has never run before.

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

**Guard:** Current time $\geq$ `pendingRetryUntil`

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

**See also:** The [Formal Model (Temporal Logic, Observable Only)](#formal-model-temporal-logic-observable-only) section provides a mathematical specification of how cron expressions are evaluated through the $\texttt{Due}(\texttt{task}, t)$ predicate.

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

## Formal Model of Observable Behavior

This model combines first-order quantification over the universe scheduler objects with **future- and past-time LTL** formulas. Atomic predicates below are predicate symbols parameterised by a scheduler object variable (for example, $\texttt{RS}_x$, $\texttt{InitEnd}(R)$), and temporal operators apply to propositional formulas obtained by instantiating those predicates for concrete objects.

We use the convenient shorthand of writing instantiated propositions like $\texttt{RS}_x$ for $\texttt{RunStart}(x)$. Where a formula is stated without explicit quantifiers, the default intent is universal quantification (eg. “for all tasks x”). First-order quantification ranges over the set of scheduler objects; temporal operators reason over event positions in the trace.

This model focuses on externally observable behaviour, but does not include the error-handling part.

### Modelling Framework

* **Trace semantics:** Each trace position corresponds to an instant where an observable event occurs. Events that are simultaneous appear at the same rationals. Time bounds are background semantics only (not encoded in LTL).
* **Logic:** A combination of first-order quantification (over tasks) and **LTL with past**.

  * **Future operators:** $\texttt{G}$ (□), $\texttt{F}$ (◊), $\texttt{X}$ (next), $\texttt{U}$ (until), $\texttt{W}$ (weak until).
  * **Past operators:** $\texttt{H}$ (historically), $\texttt{O}$ (once), $\texttt{S}$ (since), $\texttt{Y}$ (previous).
  * We prefer the **stutter-invariant** past operators ($\texttt{S}$, $\texttt{H}$, $\texttt{O}$) in this spec.

### Definitions

This subsection gives a signature-based, self-contained definition of the model, followed by interpretations of each symbol.

#### Time and Traces

* **Time domain:** $\mathbb{Q}$ (rational numbers), used to timestamp observable instants, no initial event.
* **Trace:** a sequence of positions $i = 0, 1, 2, \dots$ with a timestamp function $\tau(i) \in \mathbb{Q}$ that is non-strictly increasing. At each position $i$, one or more observable events may occur.

#### Domains

* $\texttt{TaskId}$ — a finite, non-empty set of task identifiers.
* $\texttt{Result} = \{ \texttt{success}, \texttt{failure} \}$.
* $\texttt{RegistrationSet}$ — a finite mapping $R : \texttt{TaskId} \to (\texttt{Schedule}, \texttt{RetryDelay})$.
* $\texttt{Schedule}$ — an abstract predicate $\texttt{Due}(\texttt{task}: \texttt{TaskId}, t: \mathbb{Q}) \to \texttt{Bool}$ indicating minute-boundary instants when a task is eligible to start.
* $\texttt{RetryDelay} : \texttt{TaskId} \to \mathbb{Q}_{\geq 0}$ $-$ the function that maps each task to its non-negative retry delay.

**Interpretation:**
$\texttt{TaskId}$ names externally visible tasks. A $\texttt{RegistrationSet}$ is the public input provided at initialization. $\texttt{Due}$ and $\texttt{RetryDelay}$ are parameters determined by the registration set and the environment (host clock); they are not hidden internal state. Time units for $\texttt{Due}$ and $\texttt{RetryDelay}$ coincide.

#### Event Predicates (Observable Alphabet)

Each event predicate is evaluated at a trace position $i$ (we omit $i$ when clear from context):

* $\texttt{InitStart}$ — the JavaScript interpreter calls `initialize(...)`.
* $\texttt{InitEnd}(R)$ — the `initialize(...)` call returns; the effective registration set is $R$.
* $\texttt{StopStart}$ — the JavaScript interpreter calls `stop()`.
* $\texttt{StopEnd}$ — the `stop()` call returns.
* $\texttt{UnexpectedShutdown}$ — an unexpected, in-flight system shutdown occurs (e.g., process or host crash). This interrupts running callbacks and preempts further starts until a subsequent $\texttt{InitEnd}$.
* $\texttt{RunStart}(x)$ — the scheduler begins invoking the public callback for task $x$.
* $\texttt{RunEnd}(x, r)$ — that invocation completes with result $r \in \texttt{Result}$.

* $\texttt{Due}_x$ — is is start of a minute that the cron schedule for task $x$ matches.

  *Interpretation:* the cron schedule for $x$ matches the current minute boundary.
  Minute boundary is defined as the exact start of that minute.

  For example, for a cron expression `* * * * *`, a minute boundary occurs at `2024-01-01T12:34:00.00000000000000000000000000000000000000000000000000000Z` (infinitely many zeros).

  Time is defined by the host system's local clock.

* $\texttt{RetryDue}_x$ — is the instant when the backoff for the most recent failure of $x$ expires.

  *Interpretation:* is a primitive point event (like $\texttt{Due}_x$), supplied by the environment/clock. If the latest $\texttt{RunEnd}(x,\texttt{failure})$ occurs at time $t_f$, then $\texttt{RetryDue}_x$ holds at time $t_f + \texttt{RetryDelay}(x)$.

Each predicate marks the instant the named public action occurs from the perspective of the embedding JavaScript runtime: function entry ($\texttt{InitStart}$, $\texttt{StopStart}$), function return ($\texttt{InitEnd}$, $\texttt{StopEnd}$), callback invocation begin/end ($\texttt{RunStart}$, $\texttt{RunEnd}$), and exogenous crash ($\texttt{UnexpectedShutdown}$). No logging or internal bookkeeping is modeled.

### Macros

Abbreviations:

* $\texttt{IS} := \texttt{InitStart}$
* $\texttt{IE} := \exists R. \texttt{InitEnd}(R)$
* $\texttt{SS} := \texttt{StopStart}$
* $\texttt{SE} := \texttt{StopEnd}$
* $\texttt{Crash} := \texttt{UnexpectedShutdown}$
* $\texttt{RS}_x := \texttt{RunStart}(x)$
* $\texttt{REs}_x := \texttt{RunEnd}(x, \texttt{success})$
* $\texttt{REf}_x := \texttt{RunEnd}(x, \texttt{failure})$
* $\texttt{RE}_x := \texttt{REs}_x \vee \texttt{REf}_x$

---

Input predicates:

* $IE^{\text{in}}_x := \exists R.\,(\texttt{InitEnd}(R)\wedge x\in\text{dom}(R))$

  *Interpretation:* membership of $x$ in the registration set provided at the most recent initialization.

* $IE^{\text{out}}_x := \exists R.\,(\texttt{InitEnd}(R)\wedge x\notin\text{dom}(R))$

  *Interpretation:* non-membership of $x$ in the registration set provided at the most recent initialization.

* $\texttt{Registered}_x := \texttt{Bucket}(IE^{\text{in}}_x,\; IE^{\text{out}}_x)$

  *Interpretation:* membership of $x$ in the most recent observed registration set.

* $\texttt{RetryEligible}_x := (\neg \texttt{O}\ \texttt{REf}_x) \ \vee \ \texttt{Bucket}(\texttt{RetryDue}_x,\ \texttt{REf}_x)$

  *Interpretation:* before any failure of $x$ has completed, retries are allowed (eligible). After a failure completes, eligibility becomes true at the first $\texttt{RetryDue}_x$ pulse since that failure and remains true until cleared by a subsequent failure.

---

Stateful:

* **Hold-until-clear**

$$
\texttt{Hold}(\texttt{set}, \texttt{clear}) := (\neg \texttt{clear}) \; \texttt{S} \; \texttt{set}
$$

There was a $\texttt{set}$ in the past (or now), and no $\texttt{clear}$ since.

* **Bucket / set-with-reset**

$$
\texttt{Bucket}(\texttt{set}, \texttt{reset}) := (\neg \texttt{reset})\; \texttt{S} \; \texttt{set}
$$

Remember $\texttt{set}$ since the most recent $\texttt{reset}$.

* **Edge after reset** (first occurrence of $\phi$ since $\texttt{reset}$, stutter-invariant)

$$
\texttt{EdgeAfterReset}(\phi, \texttt{reset}) := \phi \wedge (\neg\phi) \; \texttt{S} \; \texttt{reset}
$$

* **At most one**

$$
\texttt{AtMostOne}(B, A) := \neg A \; \texttt{W} \; ( B \vee ( A \wedge ( \neg A \; \texttt{W} \; B ) ) )
$$

At most one $A$ between consecutive $B$’s (or forever if no next $B$).

* **Active** — between an $\texttt{IE}$ and the next $\texttt{SS}$ or $\texttt{Crash}$:

$$
\texttt{Active} := (\neg(\texttt{SS} \vee \texttt{Crash})) \; \texttt{S} \; \texttt{IE}
$$

* $\texttt{Running}_x$ — “an invocation of $x$ has begun and has not finished before the current position”:

$$
\texttt{Running}_x := (\neg \texttt{RE}_x) \; \texttt{S} \; \texttt{RS}_x \land (\neg \texttt{Crash}) \; \texttt{S} \; \texttt{RS}_x
$$

* **Pending\_x** — one outstanding obligation to perform the first start after a due tick, cleared by a start:

$$
\texttt{Pending}_x := \texttt{Hold}( \texttt{Due}_x, \texttt{RS}_x )
$$

* **RetryPending\_x** — a retry obligation that is true after a failure and cleared by $\texttt{REs}_x$:

$$
\begin{aligned}
\texttt{RetryPending}_x &:= \texttt{RetryEligible}_x \wedge \texttt{Hold}( \texttt{REf}_x, \texttt{REs}_x)
\end{aligned}
$$

  *Interpretation:* a retry obligation exists after a failure and persists until a success clears it; the obligation is gated by eligibility, which becomes true at the $\texttt{RetryDue}_x$ pulse for the most recent failure.

* **EffectiveDue\_x** — the scheduler **should actually start** task $x$ now:

$$
\texttt{EffectiveDue}_x := \texttt{Pending}_x \vee \texttt{RetryPending}_x
$$

---

### Liveness Properties

These properties state progress guarantees.
They prevent deadlocks, starvation, livelocks, and unbounded postponement of obligations.

**L1 — Every obligation is eventually served**
$$
\texttt{G}( (\texttt{Active} \wedge \texttt{Registered}_x \wedge \texttt{EffectiveDue}_x) \rightarrow \texttt{F} (\texttt{RS}_x \vee  \neg \texttt{Active} ) )
$$

For every position before $\texttt{IE}$ where $\texttt{EffectiveDue}_x$ holds, we must eventually see $\texttt{RS}_x$ (or a $\texttt{Crash}$, or $\texttt{SE}$, which reset obligations).

**L2 — Stop terminates**
$$
\texttt{G}( \texttt{SS} \rightarrow \texttt{F} \; \texttt{SE} )
$$

**L3 — Initialization completes**
$$
\texttt{G}( \texttt{IS} \rightarrow \texttt{F} \; \texttt{IE} )
$$

### Safety Properties

These properties state scheduler invariants.
They prevent invalid sequences of events.

**S1 — Per-task non-overlap**
$$
\texttt{G}( \texttt{RS}_x \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; (\texttt{RE}_x \vee \texttt{Crash})) )
$$
Once a run starts, no further $\texttt{RS}_x$ may occur before a matching $\texttt{RE}_x$ or $\texttt{Crash}$.

**S2 — Ends follow starts**
$$
\texttt{G}( \texttt{RE}_x \rightarrow \texttt{Y} \; \texttt{Running}_x)
$$
Every completion must correspond to a run that was already in flight before this position.

**S3 — Start safety**
$$
\texttt{G}( \texttt{RS}_x \rightarrow ( \texttt{Active} \wedge \texttt{Registered}_x \wedge \texttt{EffectiveDue}_x ) )
$$
A start can occur only while active, registered, and there is a current obligation to run.

**S4 — Conservation of starts**

$$
\texttt{G}( \texttt{AtMostOne}(\texttt{Due}_x, \texttt{REs}_x) )
$$

Should not start a task more than once for the same due period unless it fails.

Looking directly, this is a restriction on the number of successful **completions** per due period, not starts. However, the possibility that the callback will return before the next due period prevents the scheduler from starting the task again in that same period. Thus, the restriction on successful completions indirectly restricts starts.

**S5a — Quiescence after StopEnd**
$$
\texttt{G}( \texttt{SE} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IE}) )
$$
After $\texttt{SE}$, no new starts until re-initialisation.

**S5b — StopEnd consistency**
$$
\texttt{G}( \texttt{SE} \rightarrow (\neg \texttt{RE}_x \; \texttt{W} \; \texttt{IE}) )
$$
After $\texttt{SE}$, no new ends until re-initialisation.

**S6a — Crash quiescence**
$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IE}) )
$$
After a crash, no new starts until re-initialisation.

**S6b — Crash consistency (no fabricated completions)**
$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RE}_x \; \texttt{W} \; \texttt{IE}) )
$$
A crash cannot be followed by any ends until re-initialisation.

---

### Fairness Assumptions

Assumptions that cannot be verified by a scheduler implementation.

**A1 — Starts eventually settle**
$$
\texttt{G}( \texttt{RS}_x \rightarrow \texttt{F}( \texttt{RE}_x \vee \texttt{Crash} ) )
$$
Every callback invocation completes in **finite** time unless pre-empted by $\texttt{Crash}$. No uniform upper bound is required; the assumption only rules out infinite executions.

**F0 — Non-Zeno trace.**
There are not infinitely many trace positions within any bounded real-time interval.

---

### Example Acceptable Traces (informative)

**Trace 1 — Normal operation**

```js
IS
IE              // task "1" registered
Due_1
RS_1            // consumes Pending_1
REs_1
Due_1
RS_1
REf_1
RetryDue_1     // RetryDue_1 occurs at t_f + RetryDelay(1); eligibility becomes true then
RS_1            // consumes RetryPending_1
REs_1
```

**Trace 2 — Stop and restart**

```js
IS
IE                 // task "1" registered
SS
SE
                   // No RS_1 until re-init; no EffectiveDue_1 obligations either
IS
IE                 // task "1" registered
Due_1
RS_1
REs_1
```

**Trace 3 — Crash and restart**

```js
IS
IE                 // task "1" registered
Due_1
RS_1
Crash              // no RS_1 until next IE
IS
IE                 // task "1" registered
Due_1
RS_1               // restart after re-init
REs_1
```

### Execution Environment Model

The scheduler operates against an abstract **execution environment** $\mathcal{E}$ that constrains which traces are admissible without prescribing scheduler internals.

The environment is an orthogonal concern to the scheduler design; it is not part of the implementation. The environment is a source of non-determinism that influences observable behaviour.

This section is descriptive, not normative. More specifically:
- All formal statements in this section are truths about environments.
- All possible real-world environments do satisfy these statements.
- Formal statements in this section need not to be checked, they are true by definition. Implementors task is to map this model to real-world phenomena.

The environment contributes two orthogonal ingredients:

1. **Crash generator** — a predicate $\texttt{Crash}(t)$ over $\mathbb{Q}$. When true, the environment marks an exogenous interruption that preempts in-flight callbacks and halts the scheduler itself; properties **S5a**/**S5b** enforce the resulting quiescence in the trace.

2. **Work density function** — a dimensionless function

   $$
   \texttt{compute} : \mathbb{Q} \times \mathbb{Q} \to \mathbb{Q}_{\ge 0}
   $$

   assigning the potential amount of computational progress available over any real-time interval $[t,u)$. It satisfies, for all $t \le u \le v$:

   * **T1 (identity):** $\texttt{compute}(t,t) = 0$.
   * **T2 (additivity):** $\texttt{compute}(t,v) = \texttt{compute}(t,u) + \texttt{compute}(u,v)$.
   * **T3 (monotonicity & nonnegativity):** $\texttt{compute}(t,u) \ge 0$ and $\texttt{compute}(t,u) \le \texttt{compute}(t,v)$.

   No positivity is assumed; the environment may set $\texttt{compute}(t,u) = 0$ on arbitrary (even unbounded) intervals, modelling **freezes** where no work can progress. We write $\texttt{Frozen}(t,u)$ when $\texttt{compute}(t,u) = 0$.

#### Crash semantics

The environment selects the crash set $C$ and must satisfy the **crash–compute coupling** axiom: for each crash time $c \in C$ there exists $d > c$ with $\texttt{compute}(c,d) = 0$. Intuitively, from the instant a crash occurs, the environment withholds compute for some subsequent period (possibly infinitesimal, possibly unbounded). Freezes may also occur without a crash; the only mandated linkage is the zero-density stretch beginning at each crash.

#### Environment taxonomy (informative)

The following labels identify illustrative environment classes. They are informative definitions, not global assumptions:

* **Freezing environments:** admit arbitrarily long intervals $[t,u)$ with $\texttt{compute}(t,u) = 0$.

* **Eventually thawing environments:** there exists $U$ such that every interval of length $\ge U$ supplies some positive compute.

* **Lower-bounded-density environments:** there exist parameters $\varepsilon > 0$ and $\Delta \ge 0$ such that for all $t$ and $T \ge \Delta$, $\texttt{compute}(t,t+T) \ge \varepsilon\cdot T$ (average density after $\Delta$ never drops below $\varepsilon$).

* **Burst environments:** concentrate density in sporadic spikes; for every $M$ there are intervals of length $> M$ with arbitrarily small compute alternating with brief, high-density bursts.

---

## Real-time bounds

These are operational timing requirements for implementations and operators.
They are engineering targets.

**R1 — Scheduling latency target.**
When the scheduler is running and a task is due according to the cron layer (i.e., the system clock reaches the minute boundary specified by the task's cron expression), the implementation SHOULD start the task's callback within approximately **1 minute** of that minute boundary, assuming no deliberate stop is in progress and the task is not running already. This upper bound SHOULD scale linearly with the number of scheduled tasks (e.g., 100000 tasks = 10 minutes, 1000000 tasks = 100 minutes), but implementations SHOULD keep this as low as possible through efficient scheduling algorithms.

**R2 — Post‑restart recovery target.**
If the scheduler process restarts while a task callback was in flight, then after restart and once the task is present in the active registrations and eligible to run, the implementation SHOULD start the task's callback within approximately **1 minute** of the next eligible minute boundary, assuming no deliberate stop is in progress and the task is not running already. This upper bound SHOULD scale linearly with the number of scheduled tasks (e.g., 100000 tasks = 10 minutes, 1000000 tasks = 100 minutes), but implementations SHOULD keep this as low as possible through efficient scheduling algorithms.

### Assumptions & Notes

External factors such as OS suspension, VM pauses, heavy load, or administrative throttling can and will extend observed latencies beyond these targets; implementations SHOULD surface such deviations in metrics/logs so operators can take corrective action.

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
