# Declarative Scheduler Theory

---

## Preamble

This document defines a **formal, mathematical theory for declarative schedulers**.
It is part of the [Declarative Scheduler Specification](./scheduler.md).

### Purpose

We tell implementers exactly what **must be observable** for a scheduler to be correct. We write axioms about starts, ends, initialization, stopping, due/retry pulses, and crashes; we bound progress by the environment's granted compute; and we keep internals out of scope. The result is a portable yardstick for **conformance, fairness assumptions**, and **failure attribution**.

The implementation receives the supernatural function as an input, representing phenomena outside the formal model's scope. Conformance is defined via **downconformance under supernatural relaxations**: an implementation is conformant if failures can always be attributed to supernatural phenomena—meaning the same implementation with reduced supernaturals (and possibly different environment or timestamps) remains downconformant, eventually satisfying the theory or eliminating all supernaturals.

The goals are to
- specify conformance precisely,
- enable proofs and model checking of behaviors,
- support portable tests/oracles that attribute responsibility to the scheduler vs. the environment.

### Scope

This theory focuses on **externally observable behavior** of the scheduler, defining:
- The observable event alphabet and timing semantics
- Safety and liveness properties that schedulers MUST satisfy
- The interface contract between scheduler and execution environment

### Non-Goals

This specification does **not** cover:
- Error-handling implementation details
- Internal scheduler data structures or algorithms
- Performance optimization strategies
- Specific embedding mechanisms in JavaScript runtimes

---

## Mathematical Preliminaries & Notation

We work over **timestamped linear traces** ($\langle i \mapsto \tau(i) \in \mathbb{T} \rangle$) and reason in **first-order linear-time temporal logic with past**. Variables range over the scheduler’s observable objects and time domain. By convention, formulas without explicit quantifiers are **universally quantified**. We write $\mathrm{RS}_x$ etc. for instantiated predicates and distinguish **environment-owned** predicates/functions (clock pulses, crashes, compute/duration) from **scheduler-owned** actions (starts/ends/init/stop). Quantitative liveness uses **compute-bounded modalities**, with budgets linear in **bit-lengths** ( $|X|$ ) and a fixed **lag** ( $t_{\text{lag}}$ ). These modalities are **definition schemata** over the signature.

The universe of scheduler's objects includes **all possible objects**, not just those present in a particular trace. This means that, for instance, a task with cron expression `* * * * *` exists.

### Time & Traces

* **Time domain:** a set $\mathbb{T}$ used to timestamp observable instants. The timestamps have abstract resolution (i.e., they are not tied to any specific real-world clock). But they do correspond to real time, in the sense that for every real-world instance, there is a corresponding timestamp in $\mathbb{T}$.
* **Trace:** a sequence of positions $i = 0, 1, 2, \dots$ with a timestamp function $\tau(i) \in \mathbb{T}$ that is non-strictly increasing. At each position $i$, one or more observable events may occur. Events that are simultaneous appear at the same integer time points. Time bounds are background semantics only (not encoded in LTL). Reference to simultaneity rules is provided in axiom **EA3**.

### LTL with Past

Our formulas are written in **linear-time temporal logic with past**.
We use the following operators:

* **Future operators:** $\texttt{G}$ (□), $\texttt{F}$ (◊), $\texttt{X}$ (next), $\texttt{U}$ (until), $\texttt{W}$ (weak until).
* **Past operators:** $\texttt{H}$ (historically), $\texttt{O}$ (once), $\texttt{S}$ (since), $\texttt{Y}$ (previous).

### Encodings & Bit-Length Conventions

**Encodings and bit-length.** Fix a canonical, prefix-free, computable encoding $\llbracket\cdot\rrbracket$ from objects to bitstrings with linear-time decoding. For any object $X$, write $|X| := |\llbracket X \rrbracket|$ for the bit length of its encoding.

**Background time value and its size.** Each position $i$ is associated with a background timestamp value $t := \tau(i) \in \mathbb{T}$. Define $|t| := |\llbracket t \rrbracket|$ using a standard signed binary encoding (so this equals $1 + \lceil \log_2(1 + |t|_{\text{abs}}) \rceil$, where $|t|_{\text{abs}}$ is the absolute value of $t$). *Important:* $|t|$ measures the value of the clock, not the density of events; events may be sparse in $i$ even when $|t|$ grows.

### Helper Modalities

#### Strict compute-bounded eventually

For a given scheduler $\textsf{Scheduler}(a,b,t_{\texttt{lag}})$ and $C \in \mathbb{P}$, the modality

$$
F^{\leq C}_{\texttt{comp}!}(P)
$$

holds at time $\tau(i)$ iff there exists $j \geq i$, $U = [\tau(i), \tau(j)]$, and $S \subseteq U$ such that:

- $P$ holds at $j$,
- $\texttt{compute}(S) \leq C$,
- $\texttt{duration}(U \setminus S) \leq t_{\texttt{lag}}$.

Intuitively, this asserts that $P$ will occur after receiving at most $C$ units of environment-provided compute from the current position, plus a small lag $t_{\texttt{lag}}$ to account for a constant delay.

This is the strict progress condition that attributes all delay to the scheduler except for the fixed lag in its witnesses.

In typical usage, $C$ is a finite value derived from the scheduler's complexity bounds, though the definition permits $C = \infty$.

#### Compute-bounded eventually

At time $\tau(i)$ and for $C \in \mathbb{P}$,

$$
\texttt{Grant}_{\ge C} \;:=\; \exists j \ge i.\; \texttt{compute}\big([\tau(i), \tau(j)]\big) \ge C.
$$

Intuitively, once $\texttt{Grant}_{\ge C}$ holds, the environment will cumulatively offer at least $C$ units of compute starting at the current instant.

$$
F^{\le C}_{\texttt{comp}}(P) \;:=\; \texttt{Grant}_{\ge C} \Rightarrow F^{\le C}_{\texttt{comp}!}(P)
$$

The regular modality only promises progress when the environment has the potential to provide at least $C$ units of compute from the current instant onward.

#### Linear-in-input compute bound

For a given scheduler $\textsf{Scheduler}(a,b,t_{\texttt{lag}})$, define:

$$
F^{\texttt{lin}(X)}_{\texttt{comp}} \;:=\; F^{\le\; a\cdot|X|+b}_{\texttt{comp}}
$$

A natural extension is to multiple inputs:

$$
F^{\texttt{lin}(X_1,\dots,X_n)}_{\texttt{comp}} \; := \; F^{\texttt{lin}(\langle X_1,\dots,X_n\rangle)}_{\texttt{comp}}
$$

---

## Domains & Data Types

* $\mathbb{T} := \mathbb{Z}$ — the time domain.
* $\mathbb{D} := \mathbb{Z_{\geq 0}}$ — the domain of durations.
* $\mathbb{P} := \mathbb{Z_{\geq 0}} \cup \{\infty\}$ — the domain of compute.
* $\mathbb{S}$ — an abstract domain of supernatural phenomenon types. Elements of $\mathbb{S}$ classify different kinds of unexplainable events (e.g., cosmic rays, memory corruption, OS anomalies). The internal structure of $\mathbb{S}$ is uninterpreted.
* $\texttt{TaskId}$ — a set of public task identifiers.
* $\texttt{Opaque}$ — a set of uninterpreted atoms where only equality is meaningful.
* $\texttt{Callback}$ — the set of externally observable callback behaviours (abstracted here to equality).
* $\texttt{Schedule}$ — an abstract object interpreted by the predicate $\texttt{Due}(\texttt{schedule}: \texttt{Schedule}, t: \mathbb{T}) \to \texttt{Bool}$ indicating minute-boundary instants when a task is eligible to start.
* $\texttt{RetryDelay} := \mathbb{D}$ — non-negative time durations.
* $\texttt{Task} := \texttt{TaskId} \times \texttt{Schedule} \times \texttt{Callback} \times \texttt{RetryDelay} \times \texttt{Opaque}$ with projections $\textsf{id}$, $\textsf{sch}$, $\textsf{cb}$, $\textsf{rd}$, $\textsf{key}$.
* $\texttt{RegistrationList}$ — a finite ordered list $R = \langle x_1,\dots,x_{n} \rangle$ of tasks. Indexing uses $R[i]$ for $1 \le i \leq n$ and strong list membership $x \in_{\text{list}} R \iff \exists i.\; R[i] = x$. Duplicate tasks are possible in a list.
* $\texttt{ValidRegistrations}$ — a set of valid registration lists. They are truths about the environment. The scheduler must handle any $R \in \texttt{ValidRegistrations}$.

**Interpretation:**
$\texttt{TaskId}$ names externally visible tasks. A $\texttt{Task}$ is the raw 4-tuple provided at registration time, plus the $\texttt{Opaque}$ value, where $\textsf{key}(x)$ is an equality-only argument attached to that tuple so the specification can refer to that exact instance without implying pointer semantics or constraining key generation or reuse. The key is not explicitly passed into registration, and it is not directly observable by scheduler implementations. A $\texttt{RegistrationList}$ is the public input provided at initialization; its order and multiplicities are significant, and duplicate identifiers may appear both within a single list and across successive initializations. $\texttt{Due}$ and $\texttt{RetryDelay}$ are parameters determined by the environment (host clock); they are not hidden internal state. Time units for $\texttt{Due}$ and $\texttt{RetryDelay}$ coincide.

Durations in $\mathbb{D}$ correspond to *some* real-world durations.
For example, it could be that $\texttt{duration}([0, 999])$ is one hour.

Even though duplicates are possible in a registration list, the $\texttt{ValidRegistrations}$ has those lists excluded. Therefore, the scheduler must reject any list with duplicates. This is to model the situation where users may supply lists with duplicates, but they are invalid and must be rejected.

### Helper Equalities on Tasks

Define id-only equality for raw tasks by $x \approx y \iff \textsf{id}(x) = \textsf{id}(y)$.

Lift this pointwise to registration lists with $R \approx R' \iff |R| = |R'| \wedge \forall i.\; R[i] \approx R'[i]$.

---

## Observable Alphabet

Each event predicate is evaluated at a trace position $i$ (we omit $i$ when clear from context):

---

* $\texttt{InitStart}(R)$ — the JavaScript interpreter calls `initialize(...)`. The effective registration set is $R$.

---

* $\texttt{InitSuccess}(R)$ — the `initialize(...)` call returns normally. The effective registration set is $R$.

---

* $\texttt{InitFailure}(R)$ — the `initialize(...)` call throws an error. The effective registration set is $R$.

---

* $\texttt{StopStart}$ — the JavaScript interpreter calls `stop()`.

---

* $\texttt{StopEnd}$ — the `stop()` call returns.

---

* $\texttt{RunStart}(x)$ — the public callback of task $x$ is called.

---

* $\texttt{RunSuccess}(x)$ — an invocation completes and returns normally.

This event is an environment-supplied truth that occurs when the callback returns without throwing. It cannot be caused or prevented by the scheduler. The scheduler may not know whether the callback will succeed or fail or loop forever.

---

* $\texttt{RunFailure}(x)$ — an invocation ends by throwing an error.

This event is an environment-supplied truth that occurs when the callback returns by throwing an error. It cannot be caused or prevented by the scheduler. The scheduler may not know whether the callback will succeed or fail or loop forever.

---

* $\texttt{UnexpectedShutdown}$ — an unexpected, in-flight system shutdown occurs (e.g., process or host crash). This interrupts running callbacks and preempts further starts until a subsequent $\texttt{IE}$. 

This predicate is supplied by the environment's crash generator.
It is not controlled by the scheduler. The scheduler may not know when a crash will occur.

---

* $\texttt{supernatural}: \mathbb{T} \to \mathcal{P}(\mathbb{S})$ — a function mapping each time instant to the set of supernatural phenomenon types occurring at that instant.

*Interpretation:* This function classifies unexplainable events by their types. At each time $t$, $\texttt{supernatural}(t)$ returns the set of supernatural phenomenon types present at that instant. When $\texttt{supernatural}(t) = \emptyset$, no supernatural events occur at time $t$. The abstract domain $\mathbb{S}$ might include types like cosmic-ray-induced bit flips, silent memory corruption, undetected CPU faults, clock anomalies, or OS/VM glitches—any phenomena that occur in the real world but are not expressible within the scheduler theory's signature. The name reflects the perspective that just as supernatural events are unexplainable by science, these phenomena are unexplainable by (and underivable from) the formal scheduler theory.

To recognize which things constitute supernatural phenomena, see the [Classification of Supernatural Phenomena](./scheduler-supernatural.md).

---

* $\texttt{Due}_x$ — is start of a minute that the cron schedule for task $x$ matches.

*Interpretation:* the cron schedule for $x$ matches the start of a *civil* minute according to the host system's local clock.

For example, for a cron expression `* * * * *`, a due fires at `2024-01-01T12:34:00` local time, at the exact start of that minute.

Important: task does not have to be registered for $\texttt{Due}_x$ to occur.

Note: because of DST and other irregularities of a civil clock, minute starts are not uniformly spaced in $\mathbb{T}$.

---

* $\texttt{RetryDue}_x$ — is the instant when the backoff for a failure of $x$ expires.

  It is formally defined as:

  $$
  \texttt{RetryDue}_x \texttt{ at } i :=(\texttt{REf}_x \texttt{ at } j) \land \exists_{j} \; \Big(\tau(j) + \textsf{rd}(x) = \tau(i)\Big)
  $$

*Interpretation:* is a primitive point event (like $\texttt{Due}_x$), supplied by the environment/clock. If the latest $\texttt{RunFailure}(x)$ occurs at time $t_f$, then $\texttt{RetryDue}_x$ holds at time $t_f + \textsf{rd}(x)$. These pulses are truths about the environment.

---

Each predicate marks the instant the named public action occurs from the perspective of the embedding JavaScript runtime: function entry ($\texttt{InitStart}$, $\texttt{StopStart}$), function return ($\texttt{IE}$, $\texttt{StopEnd}$), callback invocation begin/end ($\texttt{RunStart}$, $\texttt{RE}$), and exogenous crash ($\texttt{UnexpectedShutdown}$). No logging or internal bookkeeping is modeled.

## Macros

### Abbreviations

* $\texttt{IS}_R := \texttt{InitStart}(R)$
* $\texttt{IEs}_R := \texttt{InitSuccess}(R)$
* $\texttt{IEf}_R := \texttt{InitFailure}(R)$
* $\texttt{IE}_R := \texttt{IEs}_R \vee \texttt{IEf}_R$
* $\texttt{IEs} := \exists R . \; \texttt{IEs}_R$
* $\texttt{IEf} := \exists R . \; \texttt{IEf}_R$
* $\texttt{IE} := \exists R . \; \texttt{IE}_R$
* $\texttt{SS} := \texttt{StopStart}$
* $\texttt{SE} := \texttt{StopEnd}$
* $\texttt{Crash} := \texttt{UnexpectedShutdown}$
* $\texttt{RS}_x := \texttt{RunStart}(x)$
* $\texttt{REs}_x := \texttt{RunSuccess}(x)$
* $\texttt{REf}_x := \texttt{RunFailure}(x)$
* $\texttt{RE}_x := \texttt{REs}_x \vee \texttt{REf}_x$

### Stateful

* $\texttt{Hold}(\texttt{set}, \texttt{clear}) := \Big((\neg \texttt{clear}) \; \texttt{S} \; \texttt{set}\Big) \land \neg \texttt{clear}$

There was a $\texttt{set}$ in the past (or now), and no $\texttt{clear}$ since.

This is a strict version - if clear and set occur simultaneously, the result is false.

---

* $\texttt{Hold}^{+}(\texttt{set}, \texttt{clear}) := \texttt{Hold}(\texttt{set}, \texttt{clear}) \lor \texttt{set}$

An inclusive version of $\texttt{Hold}$ - if set and clear occur simultaneously, the result is true.

---

* $\texttt{AtMostOne}(B, A) := \texttt{G} \Big(A \rightarrow \ \texttt{X} (\neg A \; \texttt{W} \; B ) \Big)$

At most one $A$ between consecutive $B$'s.
One single $A$ is allowed if there is no next $B$.

---

* $\texttt{MinuteStart} := \exists_x \; \texttt{Due}_x$

Starts of civil minutes.

To see why this definition works, note that every minute boundary in the civil clock induces a $\texttt{Due}$ pulse for the cron expression `* * * * *`. 
Because that expression is contained within every other expression, whenever any task becomes due, the wildcard expression is also due.
Conversely, the wildcard expression is defined precisely for minute starts.
Therefore the existential over all tasks captures exactly the instants that are the start of a minute.

---

* $\texttt{MountainDue}_x := (\neg \texttt{MinuteStart}) \; \texttt{S} \; \texttt{Due}_x$

This macro holds continuously from the instant of $\texttt{Due}_x$ until, but not including, the next $\texttt{MinuteStart}$.

Effectively this keeps the duty cycle "high" for the entire minute.
The past-time $\texttt{S}$ operator requires that the most recent $\texttt{Due}_x$ occurred before the current position and that no $\texttt{MinuteStart}$ has happened since, which means $\texttt{MountainDue}_x$ is true exactly while the civil minute that began with $\texttt{Due}_x$ is still in progress.

---

* $\texttt{Registered}_{R} := \texttt{Hold}(\texttt{IEs}_{R}, \exists R' \neq R . \; \texttt{IEs}_{R'})$

Reference to the most recent successful initialization **of a specific** registration list $R$.

---

* $\texttt{Registered}_{R, x} := \texttt{Registered}_{R} \land x\in_\text{list}R$

Membership of $x$ in the most recent observed registration list.

Note that this does not imply $\texttt{Active}$.

---

* $\texttt{Registered}^{\approx}_{R, x} := \exists_{x' \approx x} \; \; \texttt{Registered}_{R, x'}$

A weaker version of $\texttt{Register}$ that considers only task identifier, not the full task tuple.

---

* $\texttt{SS}_R := \texttt{SS} \land \texttt{Registered}_R$

Stop started **for a specific** registration list $R$.

---

* $\texttt{SE}_R := \texttt{SE} \land \texttt{Registered}_R$

Stop ended **for a specific** registration list $R$.

---

* $\texttt{FirstComing}_x := (\exists R . \; \texttt{Registered}^{\approx}_{R, x}) \wedge \neg \Big(\exists R . \; (\texttt{Y} \; \texttt{Registered}^{\approx}_{R, x})\Big)$

The moment of appearance of task named $\textsf{id}(x)$ such that it was not present in the previous registration list.

Note that the comparison is by identifiers, not by full task tuple.

This property allows completely "forgetting" a task after it has been removed instead of tracking its retry/due states forever.

---

* $\texttt{Active}_R := \texttt{Hold}(\texttt{IEs}_R, \texttt{SS}_R \vee \texttt{Crash} \lor \exists{R' \neq R} . \; \texttt{IEs}_{R'})$

True for an active registration list $R$.
Determines boundary of when tasks in $R$ can start.
The last disjunct ensures that $\texttt{Active}_R$ becomes false if a new initialization with a different list occurs.

---

* $\texttt{Running}_x := \texttt{Hold}(\texttt{RS}_x, \texttt{RE}_x \lor \texttt{Crash})$

An invocation of $x$ has begun and has not finished before the current position.

---

* $\texttt{Quiescent} := \neg \exists y.\; \texttt{Running}_y$

No callbacks are currently running.

---

* $\texttt{FirstQuiescentSince}(\sigma) := \texttt{Quiescent} \wedge (\neg \texttt{Quiescent} \; \texttt{S} \; \sigma)$

The first instant at or after $\sigma$ when the system becomes quiescent.

---

* $\texttt{Orphaned}_x := \texttt{Crash} \wedge \texttt{Hold}(\texttt{RS}_x, \texttt{RE}_x)$

An interruption of task $x$ by a crash.

---

* $\texttt{RSucc}_x := \texttt{RS}_x \wedge \Big( \neg (\texttt{REf}_x \lor \texttt{Crash}) \; \texttt{U} \; \texttt{REs}_x \Big)$

A start of run that eventually completes successfully (not preempted by failure or crash).

---

* $\texttt{DuePending}_x := \texttt{Hold}^{+}( \texttt{Due}_x, \texttt{RS}_x \lor \texttt{FirstComing}_x ) \wedge \neg \texttt{Running}_x$

An outstanding request to perform a start after a due tick, cleared by a start and by $\texttt{FirstComing}_x$.
But the task is not pending if it is currently running.

The reason that $\texttt{FirstComing}_x$ clears $\texttt{DuePending}_x$ is that the scheduler should not start all tasks at once after the first initialization - not to overwhelm the system.

---

* $\texttt{RetryPending}_x := \texttt{Hold}^{+}( \texttt{RetryDue}_x, \texttt{RS}_x \lor \texttt{FirstComing}_x) \wedge \neg \texttt{Running}_x$

A retry request exists after a failure and persists until it is retried.

Similarly to $\texttt{DuePending}_x$, the task is not retry-pending if it is currently running.

Similarly to $\texttt{DuePending}_x$, $\texttt{FirstComing}_x$ clears $\texttt{RetryPending}_x$.

---

* $\texttt{OrphanedPending}_x := \texttt{Hold}( \texttt{Orphaned}_x, \texttt{RS}_x \lor \texttt{FirstComing}_x )$

A task $x$ that was interrupted by a crash and has not yet been restarted.

---

* $\texttt{BootDuePending}_x := \texttt{FirstComing}_x \land \texttt{MountainDue}_x \land \neg \texttt{Running}_x$

Task $x$ has just appeared and the current civil minute is one when $x$ is due - so it is pending unless already running.

---

* $\texttt{Pending}_x := \texttt{DuePending}_x \vee \texttt{RetryPending}_x \vee \texttt{OrphanedPending}_x \vee \texttt{BootDuePending}_x$

A task $x$ is ready to run.

---

* $\texttt{Obligation}_{R, x} := \texttt{Pending}_x \wedge \texttt{Registered}_{R, x} \wedge \texttt{Active}_{R}$

The scheduler **should actually start** task $x$ now.

---

* $\texttt{Obligation}_{x} := \exists R . \; \texttt{Obligation}_{R, x}$

An abbreviation.

---

## Environment

The scheduler operates against an abstract **Environment** $\mathcal{E}$.

The environment is an orthogonal concern to the scheduler design; it is a source of non-determinism that influences observable behaviour.

This section is **informative**. The formulas enumerated here are axioms about the environments we target:

- All formal statements in this section are truths about environments in scope.
- All possible real-world environments in scope satisfy these statements.
- Implementors need not prove these axioms; the task is to map environments to this theory.

Some environments make it impossible to implement a useful scheduler (for example, permanently freezing environments), but for all environments there exist conformant schedulers. The value of this section is to clarify the blame assignment between scheduler and environment.

Among others, environments contribute these ingredients:

1. **Crash generator** — a predicate $\texttt{Crash}$ over trace positions. When true, the environment marks an exogenous interruption that preempts in-flight callbacks and halts the scheduler itself; axiom **EA1** enforces the resulting quiescence in the trace.

2. **Compute event predicate** — a predicate $\texttt{Compute}$ over trace positions indicating instants when the environment could execute one microinstruction of the scheduler implementation. This is an environment-owned primitive that marks opportunities for scheduler progress.

   From this predicate, we derive the **compute function**:

   $$
   \texttt{compute}(S) := |\{ \tau(i) \in S \mid \texttt{Compute} \texttt{ at } i \}|
   $$

   which counts how many compute events occur within a set $S \subseteq \mathbb{T}$ of time points. The result is in $\mathbb{P} = \mathbb{Z}_{\geq 0} \cup \{\infty\}$ (the count may be infinite for unbounded sets).

   Compute events are only spent on scheduler's actions.
   So, in particular, these do not require or "consume" compute events:
   - IO operations,
   - scheduler's sleeping or waiting,
   - garbage collection,
   - progress of callbacks (except for starting and ending them),
   - other activity of the embedding JavaScript runtime.
   
   More specifically, $\texttt{Compute}$ marks the potential for executing the scheduler's own code (and of its JavaScript dependencies), not anything else.

   It is expected that the scheduler will have access to fewer compute events when more callbacks are running, but this is a very vague assumption, so not formalising it here.

### Core Environment Axioms

The statements in this section constitute the theory $T_{\textsf{env}}$.

---

**EA1 — Busy crashing**

$$
\texttt{G}( \texttt{Crash} \rightarrow \texttt{Frozen} )
$$

No work progresses around a crash instant.

---

**EA2 - Actions require work**

$$
\texttt{G}( \texttt{RE}_x \rightarrow \texttt{Unfrozen} ) \\
\texttt{G}( \texttt{RS}_x \rightarrow \texttt{Unfrozen} ) \\
\texttt{G}( \texttt{IS}_R \rightarrow \texttt{Unfrozen} ) \\
\texttt{G}( \texttt{IE} \rightarrow \texttt{Unfrozen} ) \\
\texttt{G}( \texttt{SS} \rightarrow \texttt{Unfrozen} ) \\
\texttt{G}( \texttt{SE} \rightarrow \texttt{Unfrozen} ) \\
$$

Observable events, including end of a callback, require that some work has been spent on them.

Importantly, $\texttt{Due}_x$ and $\texttt{RetryDue}_x$ are not included here, as they are primitive truths about the environment, not actions.

---

**EA3 - No simultaneous actions**

$$
\text{For any two actions } A \neq B, \text{ and any different } R, x \text{ in } \{ \texttt{RE}_x, \texttt{RS}_x, \texttt{IS}_R, \texttt{IE}, \texttt{SS}, \texttt{SE} \}, \text{ we have:} \\
\texttt{G}( A \rightarrow \neg B ) \\
$$

Two actions cannot happen simultaneously.

---

**EA4 - Unlimited freeze**

$$
\texttt{G} \; \texttt{F} \; \texttt{Frozen} 
$$

There are infinitely many intervals of time during which no work progresses. This asserts "density" of time within compute.

---

**EA5 - Unlimited dues**

$$
\texttt{G} ( \texttt{F} \; \texttt{Due}_x) \lor \texttt{G}(\neg \texttt{Due}_x)
$$

For every task $x$, the cron schedule matches infinitely often or never at all.

This comes from the fact that cron schedules are periodic and unbounded in time.
It is impossible to have a valid cron expression that matches only finitely many times.

---

**EA6 — Crash/RE consistency**

$$
\texttt{G}\Big( \texttt{Crash} \rightarrow (\neg \texttt{RE}_x \; \texttt{W} \; \texttt{RS}_x) \Big)
$$

After a $\texttt{Crash}$, no new ends until a new start.

---

**EA7 — Ends follow starts**

$$
\texttt{G}( \texttt{RE}_x \rightarrow \texttt{Y} \; \texttt{Running}_x)
$$

Every completion must correspond to a run that was already in flight before this position. This is an environment truth because callback ends ($\texttt{RE}_x$) are environment-owned events that can only occur if the callback was actually running.

### Environment Taxonomy

The following labels identify illustrative environment classes:

* **Freezing environments:** admit arbitrarily long intervals $(t,u)$ with $\texttt{Frozen}(t, u)$ (i.e., no $\texttt{Compute}$ events).

* **Eventually thawing environments:** there exists $U$ such that every interval of length $\ge U$ contains at least one $\texttt{Compute}$ event.

* **Lower-bounded-density environments:** there exist parameters $\varepsilon > 0$ and $\Delta \ge 0$ such that for all $t$ and $T \ge \Delta$, $\texttt{compute}([t,t+T]) \ge \varepsilon\cdot T$ (average density of $\texttt{Compute}$ events after $\Delta$ never drops below $\varepsilon$).

* **Burst environments:** concentrate $\texttt{Compute}$ events in sporadic spikes; for every $M$ there are intervals of length $> M$ with arbitrarily few $\texttt{Compute}$ events alternating with brief, high-density bursts.

---

## Scheduler Axioms

The formulas in this section constitute the theory $T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$. Each axiom is parameterised by the witnesses $(a,b,t_{\texttt{lag}})$ that appear in the compute-bounded modalities.

### Safety Axioms

These axioms state scheduler invariants and prevent invalid sequences of events.

---

**S1 — Start safety**
$$
\texttt{G}( \texttt{RS}_x \rightarrow \texttt{Y} \; \texttt{Obligation}_{x} )
$$
A run can occur only after an obligation to run.

---

**S2 — Conservation of starts**

$$
\texttt{AtMostOne}(\texttt{Due}_x, \texttt{RSucc}_x)
$$

Should prevent multiple successful executions per single due period.

---

**S3 — StopEnd consistency**

$$
\texttt{G}( \texttt{SE} \rightarrow \neg \texttt{Running}_x)
$$

This means that call to `stop()` waits for in-flight callbacks to complete.

---

**S4 — Registration consistency**

$$
R \in \texttt{ValidRegistrations} \implies \texttt{G}( \neg \texttt{IEf}_R ) \\
R \notin \texttt{ValidRegistrations} \implies \texttt{G}( \neg \texttt{IEs}_R ) \\
$$

The scheduler must accept any registration list from the set of valid lists, and must reject any list not in that set.

### Liveness Axioms

These **normative** axioms state progress guarantees.
They prevent deadlocks, starvation, livelocks, and unbounded postponement of obligations.

Progress is always read relative to the environment's willingness to provide compute. In fully freezing environments (see [Environment taxonomy](#environment-taxonomy-informative)), obligations may accumulate without violating safety; in eventually thawing or lower-bounded-density environments, the fairness assumptions below become reasonable or derivable premises for liveness. In other words, in some environments, a conformant scheduler may be useless.

---

**L1 — Obligation fulfillment**

$$
\texttt{G}\Big( \texttt{Obligation}_{R, x} \rightarrow \texttt{F}_{\texttt{comp}}^{\texttt{lin}(R, \,\tau(i))} (\texttt{RS}_x \vee \neg \texttt{Active}_R )\Big)
$$

When a task is supposed to be executed, we must eventually see that execution in the form of $\texttt{RS}_x$ (or a $\texttt{Crash}$, or $\texttt{SS}$).

Furthermore, that execution occurs within a bounded **compute** (as a linear function of the sizes of the current registration list and timestamp) after the obligation arises, provided the environment actually grants that much compute from the current point onward.

---

**L2 — Initialization completes**

$$
\texttt{G}\Big( \texttt{IS}_R \rightarrow \texttt{F}_{\texttt{comp}}^{\texttt{lin}(R, \,\tau(i))} \; (\texttt{IE}_R \lor \texttt{Crash}) \Big)
$$

Similar to L1, this property ensures that once an initialization starts, it must eventually complete within a bounded amount of compute (unless preempted by a crash) whenever the environment supplies that budget.

---

**L3 — Stop completes after quiescence**

$$
\texttt{G}\Big(\, \texttt{SS}_R \;\rightarrow\;
  \texttt{G}\big(\, \texttt{FirstQuiescentSince}(\texttt{SS}_R) \;\rightarrow\;
    F_{\texttt{comp}}^{\texttt{lin}(R,\, \tau(i))}\big( \texttt{SE}_R \;\lor\; \texttt{Crash} \big)
  \big)\Big)
$$

**Reading.** After $\texttt{SS}_R$, as soon as the system first becomes quiescent (no callbacks running), the scheduler must complete `stop()` within a compute budget linear in the sizes of the registration list and current timestamp (modulo environment grants), or else be pre-empted by $\texttt{Crash}$.

---

## Structures & Satisfaction

### Signature & Structures

We work over a multi-sorted first-order signature $\Sigma_{\textsf{sch}}$ with the following sorts:

* $\mathbb{T}$ (timestamps), $\mathbb{D}$ (durations), $\mathbb{P}$ (compute budgets), and $\mathbb{S}$ (supernatural phenomenon types).
* $\texttt{TaskId}$, $\texttt{Opaque}$, $\texttt{Callback}$, $\texttt{Schedule}$, $\texttt{RetryDelay}$, $\texttt{Task}$, and $\texttt{RegistrationList}$.
* Auxiliary finite sets such as $\texttt{ValidRegistrations}$ and Boolean values $\mathbb{B}$.

Function symbols include:

* $\tau : \mathbb{N} \to \mathbb{T}$ (timestamp map over trace positions).
* $\texttt{duration} : \mathcal{P}(\mathbb{T}) \to \mathbb{D}$ and $\texttt{compute} : \mathcal{P}(\mathbb{T}) \to \mathbb{P}$ (where $\texttt{compute}$ is defined via the $\texttt{Compute}$ predicate as described in [Environment Axioms](#environment-axioms)).
* $\texttt{supernatural} : \mathbb{T} \to \mathcal{P}(\mathbb{S})$ (mapping time instants to sets of supernatural phenomenon types).
* Task projections $\textsf{id}$, $\textsf{sch}$, $\textsf{cb}$, $\textsf{rd}$, $\textsf{key}$, list operations (length, indexing), and the environment parameters $\texttt{Due}$, $\texttt{RetryDue}$.

Predicate symbols cover the observable alphabet. They include scheduler-owned atoms $\texttt{IS}_R$, $\texttt{IE}$, $\texttt{SS}$, $\texttt{SE}$, $\texttt{RS}_x$, $\texttt{REs}_x$, $\texttt{REf}_x$, as well as environment-owned atoms such as $\texttt{Compute}$, $\texttt{Crash}$, $\texttt{Due}_x$, and $\texttt{RetryDue}_x$, and the standalone supernatural predicate $\texttt{Supernatural}$. Indexed predicates range over the appropriate sorts (e.g., $x$ ranges over $\texttt{Task}$, $R$ over $\texttt{RegistrationList}$); $\texttt{SS}$ and $\texttt{SE}$ are 0-ary.

The free constants $(a,b,t_{\texttt{lag}})$ are theory parameters that instantiate compute-bounded modalities within $T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$.

An environment is packaged as the tuple

$$
\mathcal{E} = \langle \texttt{Compute}, \texttt{Crash}, \texttt{Due}_x, \texttt{RetryDue}_x, \texttt{REs}, \texttt{REf}, \texttt{SS}, \texttt{IS}_R \rangle
$$

providing the interpretations for environment-owned predicates listed above. The $\texttt{compute}$ function is then derived from $\texttt{Compute}$ by counting.

A scheduler behavior is similarly packaged as

$$
\mathcal{S} = \langle \texttt{IE}_R, \texttt{SE}, \texttt{RS}_x \rangle
$$

providing the interpretations for scheduler-owned predicates.

The supernatural function is packaged as

$$
\mathcal{N} = \langle \texttt{supernatural} \rangle
$$

providing the interpretation for the function mapping time instants to sets of supernatural phenomenon types that exist outside the theory's formal scope.

> **ownership note.** We classify predicate symbols by ownership: environment-owned predicates are interpreted directly from the environment tuple $\mathcal{E}$, while scheduler-owned predicates are produced by the scheduler behavior $\mathcal{S}$. The supernatural function $\mathcal{N}$ stands separately as it represents phenomena that are neither controlled by the environment nor the scheduler but exist outside the formal model. This classification is informative; it explains which component determines the symbol's interpretation inside any structure.

### Satisfaction & Models

The satisfaction judgment uses linear-time temporal logic with past over trace positions equipped with $\tau$. Definition schemata $F_{\texttt{comp}!}$, $F_{\texttt{comp}}$, and $F^{\texttt{lin}}_{\texttt{comp}}$ are macros over this signature.

Let $T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$ denote the set of **Scheduler Axioms**: S1–S4 and L1–L3 with every modality instantiated using the same witnesses $(a,b,t_{\texttt{lag}})$. Let $T_{\textsf{env}}$ denote the **Environment Axioms** EA1–EA7.

We write

$$
\langle \mathcal{E}, \mathcal{S}, \mathcal{N}, \tau \rangle \models \varphi
$$

to mean that the structure interpreting environment-owned symbols via $\mathcal{E}$, scheduler-owned symbols via $\mathcal{S}$, the supernatural function via $\mathcal{N}$, and the timestamp map via $\tau$ satisfies the temporal formula $\varphi$ in the standard LTL-with-past semantics. Here, $\mathcal{E} \in \text{Env}$ is an individual environment, $\mathcal{S} \in \text{Sch}$ is an individual scheduler behavior, and $\mathcal{N} \in \text{Supernatural}$ is the supernatural function mapping time to phenomenon types.

### Models of the Theory

A trace over $\Sigma_{\textsf{env}} \cup \Sigma_{\textsf{sch}} \cup \Sigma_{\textsf{supernatural}}$ with timestamps $\tau$ yields a **structure** $\langle \mathcal{E}, \mathcal{S}, \mathcal{N}, \tau \rangle$. The structure is a **model of the theory**, written as $\langle \mathcal{E}, \mathcal{S}, \mathcal{N}, \tau \rangle \models T$, iff:

1. Environment-owned predicates are interpreted exactly as the lifts provided by the environment tuple $\mathcal{E}$ (which includes $\texttt{Compute}$, $\texttt{Crash}$, $\texttt{Due}$, $\texttt{RetryDue}$, $\texttt{REs}$, $\texttt{REf}$, $\texttt{SS}$, and $\texttt{IS}_R$).
2. Scheduler-owned predicates are produced by the scheduler behavior $\mathcal{S}$ (at most one observable action per position, cf. EA3).
3. The supernatural function is interpreted via $\mathcal{N}$, mapping each time instant to the set of supernatural phenomenon types occurring at that instant.
4. The structure satisfies every axiom in $T_{\textsf{env}} \cup T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$.

This perspective separates scheduler obligations from environmental truths (see [Environment Axioms](#environment-axioms)) and supernatural phenomena, anchoring liveness reasoning in the satisfaction relation defined above.

## Conformance

### Implementations

A **scheduler implementation** is a function

$$
\boxed{\mathcal{I} : \text{Env} \times \text{Supernatural} \times (\mathbb{N} \to \mathbb{T}) \to \text{Sch}}
$$

that maps each triple of environment $\mathcal{E}$, supernatural function $\mathcal{N}$, and timestamp function $\tau$ to a scheduler behavior $\mathcal{S}$. Here, $\text{Env}$ denotes the space of all possible environments (each providing $\texttt{Compute}$, $\texttt{Crash}$, $\texttt{Due}_x$, $\texttt{RetryDue}_x$, $\texttt{REs}_x$, $\texttt{REf}_x$, $\texttt{SS}$, and $\texttt{IS}_R$), $\text{Supernatural}$ denotes the space of all possible supernatural functions (each mapping $\mathbb{T} \to \mathcal{P}(\mathbb{S})$), and $\text{Sch}$ denotes the space of all possible scheduler behaviors (producing $\texttt{IE}_R$, $\texttt{SE}$, and $\texttt{RS}_x$ events).

The implementation $\mathcal{I}$ is the abstract representation of the scheduler's code: given any environment, supernatural function, and timestamp function, it determines how the scheduler will respond. The timestamp function provides the temporal context for the scheduler's decisions. However, note that causality works both ways: the environment influences the scheduler's behavior, and the scheduler's actions affect the environment (e.g., by initiating callbacks).

### World Theory

The **world theory** $T_{\mathrm{world}}$ represents our background assumptions about physical reality, causality, and basic sanity constraints that any reasonable execution trace must satisfy. It acts as a precondition for attributing failures: we only consider a structure's conformance when the world itself behaves sanely.

**Intuition**: $T_{\mathrm{world}}$ captures statements like "time flows forward," "events have causes," "the same action cannot both succeed and fail simultaneously," and other fundamental constraints that would be violated only in physically impossible or logically incoherent scenarios.

**Key properties**:

1. **Subsumes environment theory**: We assume $T_{\mathrm{env}} \subseteq T_{\mathrm{world}}$. Since $T_{\mathrm{env}}$ consists of axioms that hold for all real-world environments (as stated in [Environment](#environment)), these are also basic truths about the world.

2. **Rejects empty supernatural functions**: We assume that for any structure $\langle \mathcal{E}, \mathcal{S}, \mathcal{N}, \tau \rangle$ where $\forall t.\; \mathcal{N}(t) = \emptyset$ (no supernatural phenomena at any time), we have:
   $$
   \langle \mathcal{E}, \mathcal{S}, \mathcal{N}, \tau \rangle \not\models T_{\mathrm{world}}
   $$
   
   This is a safe and useful assumption: in any real execution, *some* phenomena outside our formal model's scope exist—at minimum, irrelevant background facts like "the sun rose today".

The theory $T_{\mathrm{world}}$ itself is not explicitly axiomatized in this specification; it remains a parameter representing the reader's background physical and logical assumptions. Different formal verification efforts may instantiate $T_{\mathrm{world}}$ differently, but the properties above constrain its relationship to our scheduler theory.

### Relaxation

For a **fixed implementation** $\mathcal{I}$ and a structure

$$
\mathcal{M}(\mathcal{I}) = \langle \mathcal{E}, \mathcal{I}(\mathcal{E}, \mathcal{N}, \tau), \mathcal{N}, \tau \rangle
$$

define the **relaxation order** $\preceq_{\mathcal{I}}$ by:

$$
\mathcal{M}' \preceq_{\mathcal{I}} \mathcal{M}
\quad \text{iff} \quad
\mathcal{M}' = \langle \mathcal{E}', \mathcal{I}(\mathcal{E}', \mathcal{N}', \tau'), \mathcal{N}', \tau' \rangle, \;
\mathcal{M} = \langle \mathcal{E}, \mathcal{I}(\mathcal{E}, \mathcal{N}, \tau), \mathcal{N}, \tau \rangle, \;
\text{and} \;
\forall t.\; \mathcal{N}'(t) \subseteq \mathcal{N}(t)
$$

No other components are constrained by the preorder: $\mathcal{E}'$ and $\tau'$ may differ arbitrarily from $\mathcal{E}$ and $\tau$.

**Intuition**: The preorder $M' \preceq_{\mathcal{I}} M$ means "$M'$ has fewer supernatural phenomena than $M$" (pointwise subset on the supernatural function) while keeping the same implementation. The environment and timestamp function may change freely. This captures the idea of "running the same implementation with fewer supernatural disruptions."

### Downconformance

Let $T_{\mathrm{world}}$ be the reader's fixed world theory (sanity axioms about the physical world and causality). Then let $T(a, b, t_{\mathrm{lag}}) := T_{\mathrm{env}} \cup T_{\mathrm{sch}}(a,b,t_{\mathrm{lag}})$.

Define **downconformance** of a structure $\mathcal{M}$ (with respect to $\mathcal{I}$) coinductively as the greatest predicate $\mathrm{DC}_{\mathcal{I}}(\cdot)$ satisfying:

$$
\boxed{
\mathrm{DC}_{\mathcal{I}}(\mathcal{M})
\;\; \text{iff} \;\;
\big(\mathcal{M} \models T_{\mathrm{world}}\big) \Rightarrow
\Big( \exists (a, b, t_{\mathrm{lag}}) \; \mathcal{M} \models T(a, b, t_{\mathrm{lag}}) \;\;\lor\;\; \big(\forall \mathcal{M}' \preceq_{\mathcal{I}} \mathcal{M}.\; \mathrm{DC}_{\mathcal{I}}(\mathcal{M}')\big) \Big)
}
$$

**Intuition**: A structure is downconformant if, whenever it is sane, either:
- the structure already satisfies the scheduler theory $T$, or
- every reduction of supernatural phenomena remains downconformant.

This coinductive definition captures that failures can be attributed to supernatural phenomena: if reducing supernaturals allows the theory to be satisfied, the original failure was due to those supernaturals; otherwise, the scheduler is at fault.

The guard $\exists t.\; \mathcal{N}(t) \neq \emptyset$ prevents vacuous satisfaction when no supernatural phenomena are present—if there are no supernaturals to blame, the scheduler must satisfy the theory directly.

### Implementation Conformance

An implementation $\mathcal{I}$ is **conformant** iff

$$
\boxed{
\forall \mathcal{M}(\mathcal{I}) .\; \mathrm{DC}_{\mathcal{I}}(\mathcal{M}(\mathcal{I}))
}
$$

**Interpretation**: A conformant implementation produces only downconformant structures. For every possible environment, supernatural function, and timestamp map, the resulting structure is downconformant.

This means that whenever the implementation fails to satisfy the theory under some supernatural function, that failure must be attributable to supernatural phenomena—specifically, the same implementation with fewer supernatural phenomena (and possibly different environment or timestamps) must remain downconformant, eventually reaching a point where the theory is satisfied or all supernaturals are eliminated.

---
