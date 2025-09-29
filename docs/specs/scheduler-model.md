# Formal Model of Scheduler's Observable Behavior

---

## 1. Preamble & Status

### Purpose

This document provides a formal specification of the scheduler's observable behavior using first-order quantification over scheduler objects with **future- and past-time LTL** formulas. Atomic predicates are parameterized by scheduler object variables (e.g., $\texttt{RS}_x$, $\texttt{InitStart}(R)$), and temporal operators apply to propositional formulas obtained by instantiating those predicates for concrete objects.

We use the convenient shorthand of writing instantiated propositions like $\texttt{RS}_x$ for $\texttt{RunStart}(x)$. Where a formula is stated without explicit quantifiers, the default intent is universal quantification (e.g., "for all tasks x", "for all registrations R"). First-order quantification ranges over the set of scheduler objects; temporal operators reason over event positions in the trace.

### Normative Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119) and [RFC 8174](https://tools.ietf.org/html/rfc8174).

### Normative vs. Informative Content

- **Normative** sections establish requirements that scheduler implementations MUST satisfy.
- **Informative** sections provide context, examples, and background information that aid understanding but do not establish requirements.

Sections are explicitly marked as **Normative** or **Informative** where applicable.


### Conformance

Given an environment $\mathcal{E}$, a scheduler implementation is said to **conform** to this specification if, there exist non-negative integers $(a,b)$, a constant $t_{\texttt{lag}} \geq 0$, such that the implementation behaves as a $\textsf{Scheduler}(a,b)$ when composed with $\mathcal{E}$, as defined in **Composition Model**.

---

## 2. Scope & Non-Goals

### Scope

This model focuses on **externally observable behavior** of the scheduler, defining:
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

## 3. Mathematical Preliminaries & Notation

### Time & Traces

* **Time domain:** a set $\mathbb{T}$ used to timestamp observable instants. The timestamps have abstract resolution (i.e., they are not tied to any specific real-world clock). But they do correspond to real time, in the sense that for every real-world instance, there is a corresponding timestamp in $\mathbb{T}$.
* **Trace:** a sequence of positions $i = 0, 1, 2, \dots$ with a timestamp function $\tau(i) \in \mathbb{T}$ that is non-strictly increasing. At each position $i$, one or more observable events may occur.

### Logic: LTL with Past

* **Future operators:** $\texttt{G}$ (□), $\texttt{F}$ (◊), $\texttt{X}$ (next), $\texttt{U}$ (until), $\texttt{W}$ (weak until).
* **Past operators:** $\texttt{H}$ (historically), $\texttt{O}$ (once), $\texttt{S}$ (since), $\texttt{Y}$ (previous).

### Encodings & Bit-Length Conventions

**Encodings and bit-length.** Fix a canonical, prefix-free, computable encoding $\llbracket\cdot\rrbracket$ from objects to bitstrings with linear-time decoding. For any object $X$, write $|X| := |\llbracket X \rrbracket|$ for the bit length of its encoding.

**Background time value and its size.** Each position $i$ is associated with a background timestamp value $t := \tau(i) \in \mathbb{T}$. Define $|t| := |\llbracket t \rrbracket|$ using a standard signed binary encoding (so this equals $1 + \lceil \log_2(1 + |t|_{\text{abs}}) \rceil$, where $|t|_{\text{abs}}$ is the absolute value of $t$). *Important:* $|t|$ measures the value of the clock, not the density of events; events may be sparse in $i$ even when $|t|$ grows.

### Helper Modalities

**Compute-bounded eventually.** Fix global non-negative constant $t_{\texttt{lag}}$. For $C \in \mathbb{P}$, the modality

$$
F^{\leq C}_{\texttt{comp}}(P)
$$

holds at time $\tau(i)$ iff there exists $j \geq i$, $U = [\tau(i), \tau(j)]$, and $S \subseteq U$ such that:

- $P$ holds at $j$,
- and $\texttt{compute}(S) \leq C$,
- and $\texttt{duration}(U \setminus S) \leq t_{\texttt{lag}}$.

Intuitively, this asserts that $P$ will occur after receiving at most $C$ units of environment-provided compute from the current position, plus a small lag $t_{\texttt{lag}}$ to account for a constant delay.

**Linear-in-input compute bound (scheduler-parameterized).**
For a given scheduler $\textsf{Scheduler}(a,b)$ with non-negative witnesses $(a,b)$, define
$$
F^{\texttt{lin}(X)}_{\texttt{comp}}(P) \;:=\; F^{\le\; a\cdot|X|+b}_{\texttt{comp}}(P).
$$

A natural extension is to multiple inputs:

$$
F^{\texttt{lin}(X_1,\dots,X_n)}_{\texttt{comp}} := F^{\texttt{lin}(\langle X_1,\dots,X_n\rangle)}_{\texttt{comp}}
$$

---

## 4. Domains & Data Types

* $\mathbb{T} := \mathbb{Z}$ — the time domain.
* $\mathbb{D} := \mathbb{Z_{\geq 0}}$ — the domain of durations.
* $\mathbb{P} := \mathbb{Z_{\geq 0}}$ — the domain of compute.
* $\texttt{TaskId}$ — a set of public task identifiers.
* $\texttt{Opaque}$ — a set of uninterpreted atoms where only equality is meaningful.
* $\texttt{Callback}$ — the set of externally observable callback behaviours (abstracted here to equality).
* $\texttt{Schedule}$ — an abstract object interpreted by the predicate $\texttt{Due}(\texttt{schedule}: \texttt{Schedule}, t: \mathbb{T}) \to \texttt{Bool}$ indicating minute-boundary instants when a task is eligible to start.
* $\texttt{RetryDelay} := \mathbb{D}$ — non-negative time durations.
* $\texttt{Task} := \texttt{TaskId} \times \texttt{Schedule} \times \texttt{Callback} \times \texttt{RetryDelay} \times \texttt{Opaque}$ with projections $\textsf{id}$, $\textsf{sch}$, $\textsf{cb}$, $\textsf{rd}$, $\textsf{key}$.
* $\texttt{RegistrationList}$ — a finite ordered list $R = \langle x_1,\dots,x_{n} \rangle$ of tasks. Indexing uses $R[i]$ for $1 \le i \leq n$ and strong list membership $x \in_{\text{list}} R \iff \exists i.\; R[i] = x$. Duplicate tasks are possible in a list.
* $\texttt{ValidRegistrations}$ — a set of valid registration lists. They are truths about the environment. The scheduler must handle any $R \in \texttt{ValidRegistrations}$.

**Interpretation:**
$\texttt{TaskId}$ names externally visible tasks. A $\texttt{Task}$ is the raw 5-tuple provided at registration time, and $\textsf{key}(x)$ is an equality-only argument attached to that tuple so the specification can refer to that exact instance without implying pointer semantics or constraining key generation or reuse. A $\texttt{RegistrationList}$ is the public input provided at initialization; its order and multiplicities are significant, and duplicate identifiers may appear both within a single list and across successive initializations. $\texttt{Due}$ and $\texttt{RetryDelay}$ are parameters determined by the environment (host clock); they are not hidden internal state. Time units for $\texttt{Due}$ and $\texttt{RetryDelay}$ coincide.

Durations in $\mathbb{D}$ correspond to *some* real-world durations.
For example, it could be that $\texttt{duration}([0, 999])$ is one hour.

Even though duplicates are possible in a registration list, the $\texttt{ValidRegistrations}$ has those lists excluded. Therefore, the scheduler must reject any list with duplicates. This is to model the situation where users may supply lists with duplicates, but they are invalid and must be rejected.

### Helper Equalities on Tasks

Define id-only equality for raw tasks by $x \approx y \iff \textsf{id}(x) = \textsf{id}(y)$.

Lift this pointwise to registration lists with $R \approx R' \iff |R| = |R'| \wedge \forall i.\; R[i] \approx R'[i]$.

---

## 5. Observable Alphabet & Ownership

### Event Predicates (Observable Alphabet)

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

* $\texttt{Due}_x$ — is start of a minute that the cron schedule for task $x$ matches.

*Interpretation:* the cron schedule for $x$ matches the start of a *civil* minute according to the host system's local clock.

For example, for a cron expression `* * * * *`, a due fires at `2024-01-01T12:34:00` local time, at the exact start of that minute.

Important: task does not have to be registered for $\texttt{Due}_x$ to occur.

Note: because of DST and other irregularities of a civil clock, minute starts are not uniformly spaced in $\mathbb{T}$.

---

* $\texttt{RetryDue}_x$ — is the instant when the backoff for a failure of $x$ expires.

  It is formally defined as:

  $$
  \texttt{RetryDue}_x \texttt{ at } i := \exists_{j} \; (\tau(j) + \textsf{rd}(x) = \tau(i)) \land (\texttt{REf}_x \texttt{ at } j)
  $$

*Interpretation:* is a primitive point event (like $\texttt{Due}_x$), supplied by the environment/clock. If the latest $\texttt{RunFailure}(x)$ occurs at time $t_f$, then $\texttt{RetryDue}_x$ holds at time $t_f + \textsf{rd}(x)$. These pulses are truths about the environment.

---

Each predicate marks the instant the named public action occurs from the perspective of the embedding JavaScript runtime: function entry ($\texttt{InitStart}$, $\texttt{StopStart}$), function return ($\texttt{IE}$, $\texttt{StopEnd}$), callback invocation begin/end ($\texttt{RunStart}$, $\texttt{RE}$), and exogenous crash ($\texttt{UnexpectedShutdown}$). No logging or internal bookkeeping is modeled.

### Ownership Partition

Let
- $\Sigma_{\textsf{env}} := \{\texttt{Crash},\ \texttt{Due}_x,\ \texttt{RetryDue}_x,\ \texttt{REs}_x,\ \texttt{REf}_x, \, \texttt{SS}, \, \texttt{IS}_R\}$ (environment–owned),
- $\Sigma_{\textsf{sch}} := \{\texttt{IE}_R,\ \texttt{SE},\ \texttt{RS}_x\}$ (scheduler–owned),

and $\texttt{RE}_x := \texttt{REs}_x \lor \texttt{REf}_x$ as a derived abbreviation.

### Timing Semantics

**Trace semantics:** Each trace position corresponds to an instant where an observable event occurs. Events that are simultaneous appear at the same integer time points. Time bounds are background semantics only (not encoded in LTL). Reference to simultaneity rules is provided in property **E3**.

### Stateful Abbreviations (Macros)

#### Abbreviations

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
* $\texttt{duration}(S) := |S|$
* $\texttt{Uninstalled} := \neg \texttt{F} \; \texttt{Unfrozen}$

#### Registration/Activation Macros

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

* $\texttt{FirstComing}_x := \big(\exists R . \; \texttt{Registered}^{\approx}_{R, x}\big) \wedge \neg (\exists R . \; (\texttt{Y} \; \texttt{Registered}^{\approx}_{R, x}))$

The moment of appearance of task named $\textsf{id}(x)$ such that it was not present in the previous registration list.

Note that the comparison is by identifiers, not by full task tuple.

This property allows completely "forgetting" a task after it has been removed instead of tracking its retry/due states forever.

---

* $\texttt{Active}_R := \texttt{Hold}(\texttt{IEs}_R, \texttt{SS}_R \vee \texttt{Crash} \lor \exists{R' \neq R} . \; \texttt{IEs}_{R'})$

True for an active registration list $R$.
Determines boundary of when tasks in $R$ can start.
The last disjunct ensures that $\texttt{Active}_R$ becomes false if a new initialization with a different list occurs.

#### Execution Macros

* $\texttt{Running}_x := \texttt{Hold}(\texttt{RS}_x, \texttt{RE}_x \lor \texttt{Crash})$

An invocation of $x$ has begun and has not finished before the current position.

---

* $\texttt{Orphaned}_x := \texttt{Crash} \wedge \texttt{Hold}(\texttt{RS}_x, \texttt{RE}_x)$

An interruption of task $x$ by a crash.

---

* $\texttt{RSucc}_x := \texttt{RS}_x \wedge \big( \neg (\texttt{REf}_x \lor \texttt{Crash}) \; \texttt{U} \; \texttt{REs}_x \big)$

A start of run that eventually completes successfully (not preempted by failure or crash).

#### Eligibility Macros 

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

* $\texttt{Pending}_x := \texttt{DuePending}_x \vee \texttt{RetryPending}_x \vee \texttt{OrphanedPending}_x$

A task $x$ is ready to run.

---

* $\texttt{Obligation}_{R, x} := \texttt{Pending}_x \wedge \texttt{Registered}_{R, x} \wedge \texttt{Active}_{R}$

The scheduler **should actually start** task $x$ now.

#### Inclusive/Exclusive Hold Combinators

* $\texttt{Hold}(\texttt{set}, \texttt{clear}) := \big((\neg \texttt{clear}) \; \texttt{S} \; \texttt{set}\big) \land \neg \texttt{clear}$

There was a $\texttt{set}$ in the past (or now), and no $\texttt{clear}$ since.

This is a strict version - if clear and set occur simultaneously, the result is false.

---

* $\texttt{Hold}^{+}(\texttt{set}, \texttt{clear}) := \texttt{Hold}(\texttt{set}, \texttt{clear}) \lor \texttt{set}$

An inclusive version of $\texttt{Hold}$ - if set and clear occur simultaneously, the result is true.

#### One-Per-Window Combinator

* $\texttt{AtMostOne}(B, A) := \texttt{G} (A \rightarrow \ \texttt{X} (\neg A \; \texttt{W} \; B ) )$

At most one $A$ between consecutive $B$'s.
One single $A$ is allowed if there is no next $B$.

---

## 6. Composition Model

### Environment Tuple

An **Environment** is a tuple
$$
\mathcal{E} \;=\; \langle \mathbb{T},\ \texttt{compute},\ \texttt{Crash},\ \texttt{Due},\ \texttt{RetryDue},\ \texttt{REs},\ \texttt{REf}, \, \texttt{SS}, \, \texttt{IS}_R \rangle
$$

with components:
- $\mathbb{T}$ the time domain (here $\mathbb{Z}$, as fixed in **Domains**),
- $\texttt{compute} : \mathcal{P}(\mathbb{T}) \to \mathbb{P}$ (work density function),
- $\texttt{Crash} : \mathbb{T} \to \mathbb{B}$,
- $\texttt{Due} : \texttt{Task} \times \mathbb{T} \to \mathbb{B}$,
- $\texttt{RetryDue} : \texttt{Task} \times \mathbb{T} \to \mathbb{B}$,
- $\texttt{REs} : \texttt{Task} \times \mathbb{T} \to \mathbb{B}$ and $\texttt{REf} : \texttt{Task} \times \mathbb{T} \to \mathbb{B}$.
- $\texttt{SS} : \mathbb{T} \to \mathbb{B}$,
- $\texttt{IS}_R : \texttt{RegistrationList} \times \mathbb{T} \to \mathbb{B}$.

### Scheduler with Linearity Witnesses

A **Scheduler with linearity witnesses $(a,b)\in \mathbb{Z}_{\ge 0}^2$** is an abstract producer of actions over $\Sigma_{\textsf{sch}}$ that, when composed with any environment $\mathcal{E}$, yields traces satisfying all **Safety** (S1–S6) and **Liveness** (L1–L3) properties, where every use of $F^{\texttt{lin}}_{\texttt{comp}}$ is instantiated with the **same** $(a,b)$.

We write $\textsf{Scheduler}(a,b)$ for this class. Intuitively, $(a,b)$ are a **witness** that the scheduler fulfills its progress obligations within a compute budget linear in the size of the inputs singled out by the modality.

### Admissible Traces

A trace over the combined alphabet $\Sigma_{\textsf{env}} \cup \Sigma_{\textsf{sch}}$ with timestamps $\tau$ is **admissible for $(\mathcal{E}, \textsf{Scheduler}(a,b))$** iff:
1. All environment-owned predicates are exactly the lifts of $\mathcal{E}$ defined above.
2. All scheduler-owned predicates are produced by the scheduler (at most one per position, cf. E3).
3. The trace satisfies the global axioms already stated in this document (time monotonicity, Safety S1–S6, Liveness L1–L3, and Environment truths E1–E6), with $F^{\texttt{lin}}_{\texttt{comp}}$ parameterized by $(a,b)$.

### Relation to the Environment Model

The scheduler model is parametric in an external execution environment ($\mathcal{E}$) (see [Environment Model](#7-environment-model-informative)).

The environment supplies exogenous phenomena and background structure: crash instants (the $\texttt{Crash}$ predicate), the real-time axis and clock alignment used by cron, and retry pulses ($\texttt{RetryDue}_x$). It also constrains progress via a compute density function.

We split the models to separate scheduler obligations/choices (this section) from assumptions about the host and world (environment). This keeps safety properties independent of the host and makes progress claims explicit about their environmental preconditions (see [Environment taxonomy](#environment-taxonomy-informative)).

---

## 7. Environment Model (Informative)

The scheduler operates against an abstract **Environment** $\mathcal{E}$, as defined in **Composition Model**, that constrains which traces are admissible without prescribing scheduler internals.

The environment is an orthogonal concern to the scheduler design; it is not part of the implementation. The environment is a source of non-determinism that influences observable behaviour.

This section is **informative**, not normative. More specifically:
- All formal statements in this section are truths about environments.
- All possible real-world environments do satisfy these statements.
- Formal statements in this section need not to be checked, they are true by definition. Implementors task is to map this model to real-world phenomena.

Some environments make it impossible to implement a compliant scheduler (for example, permanently freezing environments).
The value of this section is to clarify the blame assignment between scheduler and environment.

The environment contributes two ingredients:

1. **Crash generator** — a predicate $\texttt{Crash}(t)$ over $\mathbb{T}$. When true, the environment marks an exogenous interruption that preempts in-flight callbacks and halts the scheduler itself; property **E1** enforce the resulting quiescence in the trace.

2. **Work density function** — a dimensionless function

   $$
   \texttt{compute} : \mathcal{P}(\mathbb{T}) \to \mathbb{P}
   $$

   assigning the potential amount of computational progress available to the scheduler over any collection of time intervals. For some $\lambda > 0$ and for all $S, V \subset \mathbb{T}$, it satisfies:

   * **T1 (additivity):** $\texttt{compute}(S \cup V) = \texttt{compute}(S) + \texttt{compute}(V) - \texttt{compute}(S \cap V)$.
   * **T2 (boundedness):** $\texttt{compute}(S) \leq \lambda \cdot \texttt{duration}(S)$.

   No positivity is assumed; the environment may set $\texttt{compute}([t,u]) = 0$ on arbitrary (even unbounded) intervals, modelling **freezes** where no work can progress. We write $\texttt{Frozen}(t,u)$ when $\texttt{compute}([t,u]) = 0$. We write $\texttt{Frozen} \texttt{ at } i$ when there exists $l, r \geq 0$ such that $l + r > 0 \wedge \texttt{Frozen}(\tau(i) - l, \tau(i) + r)$. This means no work progressed in the interval surrounding the trace position. Similarly, $\texttt{Unfrozen}$ means that compute is positive in some interval surrounding the position.

   Compute is only spent on scheduler's actions.
   So, in particular, these events do not require or "consume" compute:
   - IO operations,
   - scheduler's sleeping or waiting,
   - garbage collection,
   - progress of callbacks (except for starting and ending them),
   - other activity of the embedding JavaScript runtime.
   
   More specifically, the compute function measures the potential for executing the scheduler's own code (and of its JavaScript dependencies), not anything else.

   It is expected that the scheduler will have access to less compute when more callbacks are running, but this is a very vague assumption, so not formalising it here.

### Environment Properties (Informative)

These are **informative** properties.
They state truths that all real-world environments satisfy.

---

**E1 — Busy crashing** *(Informative)*

$$
\texttt{G}( \texttt{Crash} \rightarrow \texttt{Frozen} )
$$

No work progresses around a crash instant.

---

**E2 - Actions require work** *(Informative)*

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

**E3 - No simultaneous actions** *(Informative)*

$$
\text{For any two actions } A \neq B \text{ in } \{ \texttt{RE}_x, \texttt{RS}_x, \texttt{IS}_R, \texttt{IE}, \texttt{SS}, \texttt{SE} \}, \text{ we have:} \\
\texttt{G}( A \rightarrow \neg B ) \\
$$

Two actions cannot happen simultaneously.

---

**E4 - Unlimited freeze** *(Informative)*

$$
\texttt{G} \; \texttt{F} \; \texttt{Frozen} 
$$

There are infinitely many intervals of time during which no work progresses. This asserts "density" of time within compute.

---

**E5 - Unlimited dues** *(Informative)*

$$
\texttt{G} \big( \texttt{F} \; \texttt{Due}_x \big) \lor \texttt{G}(\neg \texttt{Due}_x)
$$

For every task $x$, the cron schedule matches infinitely often or never at all.

This comes from the fact that cron schedules are periodic and unbounded in time.
It is impossible to have a valid cron expression that matches only finitely many times.

---

**E6 — Crash/RE consistency** *(Informative)*

$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RE}_x \; \texttt{W} \; \texttt{RS}_x) )
$$

After a $\texttt{Crash}$, no new ends until a new start.

### Environment Taxonomy (Informative)

The following labels identify illustrative environment classes. They are **informative** definitions, not global assumptions:

* **Freezing environments:** admit arbitrarily long intervals $(t,u)$ with $\texttt{Frozen}(t, u)$.

* **Eventually thawing environments:** there exists $U$ such that every interval of length $\ge U$ supplies some positive compute.

* **Lower-bounded-density environments:** there exist parameters $\varepsilon > 0$ and $\Delta \ge 0$ such that for all $t$ and $T \ge \Delta$, $\texttt{compute}([t,t+T]) \ge \varepsilon\cdot T$ (average density after $\Delta$ never drops below $\varepsilon$).

* **Burst environments:** concentrate density in sporadic spikes; for every $M$ there are intervals of length $> M$ with arbitrarily small compute alternating with brief, high-density bursts.

### Additional Informative Assumptions

Following are additional, **informative** assumptions that may hold in some environments. They are not part of the core model.

---

**A1 - Eventual thawing** *(Informative)*

$$
\texttt{G} \; \texttt{F} \; \texttt{Unfrozen}
$$

Eventually, the environment provides some positive compute in every future interval.

This rules out permanently freezing environments.
It is a weak form of fairness that ensures the environment does not permanently withhold all compute.

---

**A2 — Starts eventually settle** *(Informative)*

$$
\texttt{G}( \texttt{RS}_x \rightarrow \texttt{F}( \texttt{RE}_x \vee \texttt{Crash} ) )
$$

Every callback invocation completes in **finite** time unless pre-empted by $\texttt{Crash}$.
No uniform upper bound is required; the property only rules out infinite executions.
Note that this is not guaranteed - users may write non-terminating callbacks.
That's why this is an **informative** property, not a core property.

---

**A3 - Low lag** *(Informative)*

$$
t_{\texttt{lag}} < 1 \; \text{minute}
$$

If this is true, then whether any task is ever going to be missed is determined purely by $\texttt{compute}$.
A corollary is that if the environment provides enough compute, no tasks are ever missed.

---

## 8. Scheduler Contract (Normative)

### Safety Properties (Normative)

These are **normative** properties.
They state scheduler invariants.
They prevent invalid sequences of events.

---

**S1 — Start safety** *(Normative)*
$$
\texttt{G}( \texttt{RS}_x \rightarrow \exists R. \; \texttt{Y} \; \texttt{Obligation}_{R, x} )
$$
A run can occur only after an obligation to run.

---

**S2 — Conservation of starts** *(Normative)*

$$
\texttt{AtMostOne}(\texttt{Due}_x, \texttt{RSucc}_x)
$$

Should prevent multiple successful executions per single due period.

---

**S3 — StopEnd consistency** *(Normative)*

$$
\texttt{G}( \texttt{SE} \rightarrow \neg \texttt{Running}_x)
$$

This means that call to `stop()` waits for in-flight callbacks to complete.

---

**S4 — Ends follow starts** *(Normative)*

$$
\texttt{G}( \texttt{RE}_x \rightarrow \texttt{Y} \; \texttt{Running}_x)
$$

Every completion must correspond to a run that was already in flight before this position.

---

**S6 — Registration consistency** *(Normative)*

$$
R \in \texttt{ValidRegistrations} \implies \texttt{G}( \neg \texttt{IEf}_R ) \\
R \notin \texttt{ValidRegistrations} \implies \texttt{G}( \neg \texttt{IEs}_R ) \\
$$

The scheduler must accept any registration list from the set of valid lists, and must reject any list not in that set.

### Liveness Properties (Normative)

These are **normative** properties.
They state progress guarantees.
They prevent deadlocks, starvation, livelocks, and unbounded postponement of obligations.

Progress is always read relative to the environment's willingness to provide compute. In fully freezing environments (see [Environment taxonomy](#environment-taxonomy-informative)), obligations may accumulate without violating safety; in eventually thawing or lower-bounded-density environments, the fairness assumptions below become reasonable or derivable premises for liveness. In other words, in some environments, it is impossible to implement a scheduler.

---

**L1 — Obligation fulfillment** *(Normative)*

$$
\texttt{G}( \texttt{Obligation}_{R, x} \rightarrow \texttt{F}_{\texttt{comp}}^{\texttt{lin}(R, \,\tau(i))} (\texttt{RS}_x \vee \neg \texttt{Active}_R ))
$$

When a task is supposed to be executed, we must eventually see that execution in the form of $\texttt{RS}_x$ (or a $\texttt{Crash}$, or $\texttt{SS}$).

Furthermore, that execution occurs within a bounded **compute** (as a linear function of the sizes of the current registration list and timestamp) after the obligation arises.

---

**L2 — Initialization completes** *(Normative)*

$$
\texttt{G}\big( \texttt{IS}_R \rightarrow \texttt{F}_{\texttt{comp}}^{\texttt{lin}(R, \,\tau(i))} \; (\texttt{IE}_R \lor \texttt{Crash}) \big)
$$

Similar to L1, this property ensures that once an initialization starts, it must eventually complete within a bounded amount of compute (unless preempted by a crash).

---

**L3 — Stop terminates** *(Normative)*
$$
\texttt{G}\big( \texttt{SS}_R \rightarrow (\texttt{AllTerm} \rightarrow \texttt{F} \; (\texttt{SE}_R \lor \texttt{Crash} \lor \texttt{Uninstalled}))\big)
$$

No bound on compute here, as the scheduler may need to wait for in-flight callbacks to complete. The callbacks are not bounded, so no unconditional bound on stop can be given.

The $\texttt{AllTerm}$ condition accounts for callbacks that never terminate. This is a concession to the fact that users may write non-terminating callbacks. It is defined as:

$$
\texttt{AllTerm} := \forall_{y} \; (\texttt{Running}_y \rightarrow \texttt{F} \; \texttt{RE}_y)
$$

---

## 9. Derived Properties (Theorems & Corollaries)

---

**Theorem 1 — Quiescence after Crash**
$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IEs}) )
$$
After $\texttt{Crash}$ no new starts until re-initialisation.

---

**Theorem 2 — Per-task non-overlap**

$$
\texttt{G}\big( \texttt{RS}_x \rightarrow \neg \texttt{Y} \;\texttt{Running}_x \big)
$$

Once a run starts, no further $\texttt{RS}_x$ may occur before a matching $\texttt{RE}_x$ or $\texttt{Crash}$.

Follows from **S1** and the fact that $\texttt{Pending}$ requires $\neg \texttt{Running}$.

---

**Theorem 3 — Quiescence after StopEnd**

$$
\texttt{G}( \texttt{SE} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IEs}) )
$$

After $\texttt{SE}$, no new starts until re-initialisation.

Follows from **S1** and the fact that $\texttt{Obligation}$ requires $\texttt{Active}$.

---

**Theorem 4 — Crash dominance**

$$
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{RS}_x ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{RE}_x ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{IS}_R ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{IE} ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{SS} ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{SE} ) \\
$$

A crash cannot cooccur with any action.

Follows from **E1** and **E2**.

---

## 10. Examples

### Trace 1 — Normal operation

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

### Trace 2 — Stop and restart

```js
IS
IE                 // task "1" registered
SS
SE
                   // No RS_1 until re-init; no obligations either
IS
IE                 // task "1" registered
Due_1
RS_1
REs_1
```

### Trace 3 — Crash and restart

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

---

## 11. Design Notes (Informative)

### Design Rationale

This section explains key design decisions in the scheduler model:

**Environment ownership of `Due`/`RetryDue`:** These predicates represent environmental truths (clock ticks, timeout expiration) rather than scheduler decisions. This separation clarifies that the scheduler reacts to timing events but does not control when they occur.

**Quiescence rules:** The model requires that after crashes or stops, no new task starts occur until re-initialization. This ensures clean state transitions and prevents orphaned or inconsistent executions.

**Compute bounds on progress:** The liveness properties use compute-bounded modalities rather than wall-clock time bounds. This reflects the reality that scheduler progress depends on available computational resources, not merely the passage of time.

### Implementation Mapping

**JavaScript embedding:** The predicates correspond to observable function calls and returns in the JavaScript runtime. For example, `InitStart(R)` corresponds to calling `scheduler.initialize(R)`, and `RunStart(x)` corresponds to invoking the callback function for task `x`.

**Cron schedule handling:** The `Due_x` predicate abstracts the evaluation of cron expressions against the system clock. Real implementations must handle timezone changes, daylight saving time transitions, and leap seconds while maintaining the periodic properties assumed by **E5**.

---

## Appendices

### Appendix A: Symbol Index

| Symbol | Arity | Owner | Meaning | Introduced |
|--------|-------|-------|---------|------------|
| $\texttt{Crash}$ | 0 | ENV | Unexpected system shutdown | §5 |
| $\texttt{Due}_x$ | 1 | ENV | Cron schedule matches for task x | §5 |
| $\texttt{RetryDue}_x$ | 1 | ENV | Retry backoff expires for task x | §5 |
| $\texttt{REs}_x$ | 1 | ENV | Task x callback succeeds | §5 |
| $\texttt{REf}_x$ | 1 | ENV | Task x callback fails | §5 |
| $\texttt{SS}$ | 0 | ENV | Stop operation starts | §5 |
| $\texttt{IS}_R$ | 1 | ENV | Initialization starts with registration R | §5 |
| $\texttt{IE}_R$ | 1 | SCH | Initialization ends for registration R | §5 |
| $\texttt{SE}$ | 0 | SCH | Stop operation ends | §5 |
| $\texttt{RS}_x$ | 1 | SCH | Task x execution starts | §5 |
| $\texttt{Active}_R$ | 1 | - | Registration R is currently active | §5 |
| $\texttt{Running}_x$ | 1 | - | Task x is currently executing | §5 |
| $\texttt{Pending}_x$ | 1 | - | Task x is ready to execute | §5 |
| $\texttt{Obligation}_{R,x}$ | 2 | - | Scheduler must start task x in registration R | §5 |
| $\texttt{Hold}$ | 2 | - | Strict hold combinator | §5 |
| $\texttt{Hold}^+$ | 2 | - | Inclusive hold combinator | §5 |
| $\texttt{AtMostOne}$ | 2 | - | At most one occurrence combinator | §5 |

### Appendix B: Change Log (Editorial)

**Version 1.1** - Editorial restructure (this version)
- Reorganized sections according to define-before-use principle
- Added explicit normative/informative markers  
- Consolidated mathematical preliminaries
- Grouped macros by lifecycle purpose
- Added symbol index and design notes
- No semantic changes to formulas or properties

**Version 1.0** - Original specification
- Initial formal model with mixed organization

### Appendix C: Notation Crib Sheet

#### LTL Operators

**Future operators:**
- $\texttt{G}$ (□) - globally/always
- $\texttt{F}$ (◊) - eventually/finally  
- $\texttt{X}$ - next
- $\texttt{U}$ - until (strong)
- $\texttt{W}$ - weak until

**Past operators:**
- $\texttt{H}$ - historically (past globally)
- $\texttt{O}$ - once (past eventually)
- $\texttt{S}$ - since
- $\texttt{Y}$ - previous (past next)

**Precedence:** Unary operators (G, F, X, H, O, Y) bind tighter than binary operators (U, W, S)

---