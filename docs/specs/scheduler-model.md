
# Formal Model of Scheduler's Observable Behavior

---

This model combines first-order quantification over the universe scheduler objects with **future- and past-time LTL** formulas. Atomic predicates below are predicate symbols parameterised by a scheduler object variable (for example, $\texttt{RS}_x$, $\texttt{InitEnd}(R)$), and temporal operators apply to propositional formulas obtained by instantiating those predicates for concrete objects.

We use the convenient shorthand of writing instantiated propositions like $\texttt{RS}_x$ for $\texttt{RunStart}(x)$. Where a formula is stated without explicit quantifiers, the default intent is universal quantification (eg. "for all tasks x", "for all registrations R"). First-order quantification ranges over the set of scheduler objects; temporal operators reason over event positions in the trace.

This model focuses on externally observable behaviour, but does not include the error-handling part.

## Relation to the Environment Model

The scheduler model is parametric in an external execution environment ($\mathcal{E}$) (see [Execution Environment Model](#execution-environment-model)).

The environment supplies exogenous phenomena and background structure: crash instants (the $\texttt{Crash}$ predicate), the real-time axis and clock alignment used by cron, and retry pulses ($\texttt{RetryDue}_x$). It also constrains progress via a compute density function.

We split the models to separate scheduler obligations/choices (this section) from assumptions about the host and world (environment). This keeps safety properties independent of the host and makes progress claims explicit about their environmental preconditions (see [Environment taxonomy](#environment-taxonomy-informative)).

# Modelling Framework

* **Trace semantics:** Each trace position corresponds to an instant where an observable event occurs. Events that are simultaneous appear at the same integer time points. Time bounds are background semantics only (not encoded in LTL).
* **Logic:** A combination of first-order quantification (over tasks) and **LTL with past**:

  * **Future operators:** $\texttt{G}$ (□), $\texttt{F}$ (◊), $\texttt{X}$ (next), $\texttt{U}$ (until), $\texttt{W}$ (weak until).
  * **Past operators:** $\texttt{H}$ (historically), $\texttt{O}$ (once), $\texttt{S}$ (since), $\texttt{Y}$ (previous).

  Extended with two derived helper modalities that reference the environment’s $\texttt{compute}$ function and information sizes: $F^{\leq C}_{\texttt{comp}}$ (compute-bounded eventually) and $F^{\texttt{lin}}_{\texttt{comp}}$ (linear-in-input compute bound). Their semantics are given in [Notation & Helper Modalities](#notation--helper-modalities).

# Definitions

This subsection gives a signature-based, self-contained definition of the model, followed by interpretations of each symbol.

## Time and Traces

* **Time domain:** $\mathbb{Z}$ (integer numbers), used to timestamp observable instants. Time and “minute boundaries” are interpreted using the host clock as provided by the environment (see [Execution Environment Model](#execution-environment-model)).
* **Trace:** a sequence of positions $i = 0, 1, 2, \dots$ with a timestamp function $\tau(i) \in \mathbb{Z}$ that is non-strictly increasing. At each position $i$, one or more observable events may occur.

## Domains

* $\texttt{duration}(S) := |S|$ 
* $\texttt{TaskId}$ — a finite, non-empty set of task identifiers.
* $\texttt{Result} = \{ \texttt{success}, \texttt{failure} \}$.
* $\texttt{RegistrationSet}$ — a finite mapping $R : \texttt{TaskId} \to (\texttt{Schedule}, \texttt{RetryDelay})$.
* $\texttt{Schedule}$ — an abstract predicate $\texttt{Due}(\texttt{task}: \texttt{TaskId}, t: \mathbb{T}) \to \texttt{Bool}$ indicating minute-boundary instants when a task is eligible to start.
* $\texttt{RetryDelay} : \texttt{TaskId} \to \mathbb{T}_{\geq 0}$ $-$ the function that maps each task to its non-negative retry delay.

**Interpretation:**
$\texttt{TaskId}$ names externally visible tasks. A $\texttt{RegistrationSet}$ is the public input provided at initialization. $\texttt{Due}$ and $\texttt{RetryDelay}$ are parameters determined by the environment (host clock); they are not hidden internal state. Time units for $\texttt{Due}$ and $\texttt{RetryDelay}$ coincide.

Duration is the cardinality of the set $S$.
It corresponds to *some* real-time duration.
For example, it could be that $\texttt{duration}([0, 999])$ is one hour.

## Event Predicates (Observable Alphabet)

Each event predicate is evaluated at a trace position $i$ (we omit $i$ when clear from context):

---

* $\texttt{InitStart}(R)$ — the JavaScript interpreter calls `initialize(...)`. The effective registration set is $R$.

---

* $\texttt{InitEnd}(R)$ — the `initialize(...)` call returns; the effective registration set is $R$.

---

* $\texttt{StopStart}(R)$ — the JavaScript interpreter calls `stop()`. The effective registration set is $R$.

---

* $\texttt{StopEnd}(R)$ — the `stop()` call returns. The effective registration set is $R$.

---

* $\texttt{UnexpectedShutdown}$ — an unexpected, in-flight system shutdown occurs (e.g., process or host crash). This interrupts running callbacks and preempts further starts until a subsequent $\texttt{InitEnd}$. This predicate is supplied by the environment’s crash generator.

---

* $\texttt{RunStart}(x)$ — the scheduler begins invoking the public callback for task $x$.

---

* $\texttt{RunEnd}(x, r)$ — that invocation completes with result $r \in \texttt{Result}$.

---

* $\texttt{Due}_x$ — is start of a minute that the cron schedule for task $x$ matches.

*Interpretation:* the cron schedule for $x$ matches the current minute boundary.
Minute boundary is defined as the exact start of that minute.

For example, for a cron expression `* * * * *`, a minute boundary occurs at `2024-01-01T12:34:00.00000000000000000000000000000000000000000000000000000` (infinitely many zeros) local time.

Time is defined by the host system's local clock (see [Execution Environment Model](#execution-environment-model)).

Important: task does not have to be registered for $\texttt{Due}_x$ to occur.

---  

* $\texttt{RetryDue}_x$ — is the instant when the backoff for the most recent failure of $x$ expires.

*Interpretation:* is a primitive point event (like $\texttt{Due}_x$), supplied by the environment/clock. If the latest $\texttt{RunEnd}(x,\texttt{failure})$ occurs at time $t_f$, then $\texttt{RetryDue}_x$ holds at time $t_f + \texttt{RetryDelay}(x)$. These pulses are truths about the environment.

Important: task does not have to be registered for $\texttt{RetryDue}_x$ to occur.

---  

Each predicate marks the instant the named public action occurs from the perspective of the embedding JavaScript runtime: function entry ($\texttt{InitStart}$, $\texttt{StopStart}$), function return ($\texttt{InitEnd}$, $\texttt{StopEnd}$), callback invocation begin/end ($\texttt{RunStart}$, $\texttt{RunEnd}$), and exogenous crash ($\texttt{UnexpectedShutdown}$). No logging or internal bookkeeping is modeled.

## Macros

#### Abbreviations

* $\mathbb{T} := \mathbb{Z}$
* $\texttt{IS}_R := \texttt{InitStart}(R)$
* $\texttt{IE}_R := \texttt{InitEnd}(R)$
* $\texttt{SS}_R := \texttt{StopStart}(R)$
* $\texttt{SE}_R := \texttt{StopEnd}(R)$
* $\texttt{Crash} := \texttt{UnexpectedShutdown}$
* $\texttt{RS}_x := \texttt{RunStart}(x)$
* $\texttt{REs}_x := \texttt{RunEnd}(x, \texttt{success})$
* $\texttt{REf}_x := \texttt{RunEnd}(x, \texttt{failure})$
* $\texttt{RE}_x := \texttt{REs}_x \vee \texttt{REf}_x$

---

#### Input predicates

---

* $IE^{\text{in}}_{R, x} := \texttt{InitEnd}(R)\wedge x\in\text{dom}(R)$

Membership of $x$ in the registration set provided at the most recent initialization.

---

* $IE^{\text{out}}_{R, x} := \texttt{InitEnd}(R)\wedge x\notin\text{dom}(R)$

Non-membership of $x$ in the registration set provided at the most recent initialization.

---    

* $\texttt{Registered}_{R, x} := \texttt{Hold}(IE^{\text{in}}_{R, x},\; IE^{\text{out}}_{R, x})$

Membership of $x$ in the most recent observed registration set.

---

* $\texttt{FirstIE} := \texttt{IE} \wedge \neg (\texttt{Y} \; \texttt{O} \; \texttt{IE})$

This is the very first initialization in the trace.
It is treated specially to prevent spurious task starts immediately after the first initialization.

---

#### Stateful

---

* $\texttt{Hold}(\texttt{set}, \texttt{clear}) := (\neg \texttt{clear}) \; \texttt{S} \; \texttt{set}$

There was a $\texttt{set}$ in the past (or now), and no $\texttt{clear}$ since.

---

* $\texttt{AtMostOne}(B, A) := \texttt{G} (A \implies \ (\neg A \; \texttt{W} \; B ) )$

At most one $A$ between consecutive $B$’s.
One single $A$ is allowed if there is no next $B$.

---

* $\texttt{Active}_R := \texttt{Hold}(\texttt{IE}_R, \texttt{SS}_R \vee \texttt{Crash})$

Between an $\texttt{IE}$ and the next $\texttt{SS}$ or $\texttt{Crash}$.

---

* $\texttt{Running}_x := \texttt{Hold}(\texttt{RS}_x, \texttt{RE}_x \lor \texttt{Crash})$

An invocation of $x$ has begun and has not finished before the current position.

---

* $\texttt{DuePending}_x := \texttt{Hold}( \texttt{Due}_x, \texttt{RS}_x \lor \texttt{FirstIE} ) \wedge \neg \texttt{Running}_x$

An outstanding request to perform a start after a due tick, cleared by a start and by $\texttt{FirstIE}$.
But the task is not pending if it is currently running.

The reason that $\texttt{FirstIE}$ clears $\texttt{DuePending}_x$ is that the scheduler should not start all tasks at once after the very first initialization - not to overwhelm the system.

---

* $\texttt{RetryPending}_x := \texttt{Hold}( \texttt{RetryDue}_x, \texttt{RS}_x) \wedge \neg \texttt{Running}_x$

A retry request exists after a failure and persists until it is retried.

Similarly to $\texttt{DuePending}_x$, the task is not retry-pending if it is currently running.

---

* $\texttt{Pending}_x := \texttt{DuePending}_x \vee \texttt{RetryPending}_x$

A task $x$ is ready to run.

---

* $\texttt{Obligation}_{R, x} := \texttt{Pending}_x \wedge \texttt{Registered}_{R, x} \wedge \texttt{Active}_{R}$

The scheduler **should actually start** task $x$ now.

---

# Liveness Properties (normative)

These properties state progress guarantees.
They prevent deadlocks, starvation, livelocks, and unbounded postponement of obligations.

Progress is always read relative to the environment’s willingness to provide compute. In fully freezing environments (see [Environment taxonomy](#environment-taxonomy-informative)), obligations may accumulate without violating safety; in eventually thawing or lower-bounded-density environments, the fairness assumptions below become reasonable or derivable premises for liveness. In other words, in some environments, it is impossible to implement a scheduler.

**L1 — Obligation fulfillment**

$$
\texttt{G}( \texttt{Obligation}_{R, x} \rightarrow \texttt{F}_{\texttt{comp}}^{\texttt{lin}(R, \,t)} (\texttt{RS}_x \vee \neg \texttt{Active}_R ))
$$

When a task is supposed to be executed, we must eventually see that execution in the form of $\texttt{RS}_x$ (or a $\texttt{Crash}$, or $\texttt{SS}$).

Furthermore, that execution occurs within a bounded **compute** (as a linear function of the sizes of the current registration set and timestamp) after the obligation arises.

**L2 — Initialization completes**

$$
\texttt{G}( \texttt{IS}_R \rightarrow \texttt{F}_{\texttt{comp}}^{\texttt{lin}(R, \,t)} \; \texttt{IE}_R )
$$

Similar to L1, this property ensures that once an initialization starts, it must eventually complete within a bounded amount of compute.

**L3 — Stop terminates**
$$
\texttt{G}( \texttt{SS} \rightarrow \texttt{F} \; \texttt{SE} )
$$

No bound on compute here, as the scheduler may need to wait for in-flight callbacks to complete. The callbacks are not bounded, so no unconditional bound on stop can be given.

# Safety Properties (normative)

These properties state scheduler invariants.
They prevent invalid sequences of events.

**S1 — Per-task non-overlap**
$$
\texttt{G}( \texttt{RS}_x \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; (\texttt{RE}_x \vee \texttt{Crash})) )
$$
Once a run starts, no further $\texttt{RS}_x$ may occur before a matching $\texttt{RE}_x$ or $\texttt{Crash}$.

**S2 — Start safety**
$$
\texttt{G}( \texttt{RS}_x \rightarrow \exists R. \; \texttt{Obligation}_{R, x} )
$$
A start can occur only while there is a current obligation to run.

**S3 — Conservation of starts**

$$
\texttt{G}( \texttt{AtMostOne}(\texttt{Due}_x, \texttt{REs}_x) )
$$

Should prevent multiple successful completions per due period.

Conceptually, however, this is a restriction on the number of **starts** per due period, not completions.
This is because the possibility that the callback will return before the next due period prevents the scheduler from starting the task again in that same period. Critical fact here is that the scheduler does not know when a task will return. Thus, the restriction on successful completions indirectly restricts starts. This indirect restriction is in fact infinitely strong - it is a logical guarantee about starts.

**S4 — Quiescence after StopEnd**
$$
\texttt{G}( \texttt{SE} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IE}) )
$$
After $\texttt{SE}$, no new starts until re-initialisation.

**S5 — StopEnd consistency**

$$
\texttt{G}( \texttt{SE} \rightarrow (\neg \texttt{RE}_x \; \texttt{W} \; \texttt{IE}) )
$$

After $\texttt{SE}$, no new ends until re-initialisation.
This means that call to `stop()` waits for in-flight callbacks to complete.

---

# Example Acceptable Traces (informative)

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

# Execution Environment Model

The scheduler operates against an abstract **execution environment** $\mathcal{E}$ that constrains which traces are admissible without prescribing scheduler internals.

The environment is an orthogonal concern to the scheduler design; it is not part of the implementation. The environment is a source of non-determinism that influences observable behaviour.

This section is descriptive, not normative. More specifically:
- All formal statements in this section are truths about environments.
- All possible real-world environments do satisfy these statements.
- Formal statements in this section need not to be checked, they are true by definition. Implementors task is to map this model to real-world phenomena.

Some environments make it impossible to implement a compliant scheduler (for example, permanently freezing environments).
The value of this section is to clarify the blame assignment between scheduler and environment.

The environment contributes two ingredients:

1. **Crash generator** — a predicate $\texttt{Crash}(t)$ over $\mathbb{T}$. When true, the environment marks an exogenous interruption that preempts in-flight callbacks and halts the scheduler itself; property **E1** enforce the resulting quiescence in the trace.

2. **Work density function** — a dimensionless function

   $$
   \texttt{compute} : \mathcal{P}(\mathbb{T}) \to \mathbb{Q}_{\ge 0}
   $$

   assigning the potential amount of computational progress available to the scheduler over any real-time interval. For some $\lambda > 0$ and for all $S, V \subset \mathbb{T}$, it satisfies:

   * **T1 (additivity):** $\texttt{compute}(S \cup V) = \texttt{compute}(S) + \texttt{compute}(V) - \texttt{compute}(S \cap V)$.
   * **T2 (boundedness):** $\texttt{compute}(S) \leq \lambda \cdot \texttt{duration}(S)$.

   No positivity is assumed; the environment may set $\texttt{compute}([t,u]) = 0$ on arbitrary (even unbounded) intervals, modelling **freezes** where no work can progress. We write $\texttt{Frozen}(t,u)$ when $\texttt{compute}([t,u]) = 0$. We write $\texttt{Frozen}$ at a trace position $i$ when there exists $l, r \geq 0$ such that $l + r > 0 \wedge \texttt{Frozen}(\tau(i) - l, \tau(i) + r)$. This means no work progressed in the interval surrounding the trace position.

   Compute is only spent on scheduler's actions.
   So, in particular, these events do not require or "consume" compute:
   - progress of callbacks,
   - IO operations,
   - scheduler's sleeping or waiting,
   - garbage collection,
   - other activity of the embedding JavaScript runtime.
   
   More specifically, the compute function measures the potential for executing the scheduler's own code (and of its JavaScript dependencies), not anything else.

   It is expected that the scheduler will have access to less compute when more callbacks are running, but this is a very vague assumption, so not formalising it here.

## Environment properties (descriptive)

**E1 — Busy crashing**

$$
\texttt{G}( \texttt{Crash} \rightarrow \texttt{Frozen} )
$$

No work progresses around a crash instant.

**E2 — Ends follow starts**

$$
\texttt{G}( \texttt{RE}_x \rightarrow \texttt{Y} \; \texttt{Running}_x)
$$

Every completion must correspond to a run that was already in flight before this position.

**E3 - Actions require work**

$$
\texttt{G}( \texttt{RE}_x \rightarrow \neg \texttt{Frozen} ) \\
\texttt{G}( \texttt{RS}_x \rightarrow \neg \texttt{Frozen} ) \\
\texttt{G}( \texttt{IS} \rightarrow \neg \texttt{Frozen} ) \\
\texttt{G}( \texttt{IE} \rightarrow \neg \texttt{Frozen} ) \\
\texttt{G}( \texttt{SS} \rightarrow \neg \texttt{Frozen} ) \\
\texttt{G}( \texttt{SE} \rightarrow \neg \texttt{Frozen} ) \\
$$

Observable events, including end of a callback, require that some work has been spent on them.

Importantly, $\texttt{Due}_x$ and $\texttt{RetryDue}_x$ are not included here, as they are primitive truths about the environment, not actions.

**E4 - Unlimited dues**

$$
\texttt{G} \; \texttt{F} \; \texttt{Due}_x
$$

For every task $x$, the cron schedule matches infinitely often.

**S5 — Crash/RE consistency**

$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RE}_x \; \texttt{W} \; \texttt{RS}_x) )
$$

After a $\texttt{Crash}$, no new ends until a new start.

**RD1 — Nonprecedence**
$$
	\texttt{G}\big( ( \neg \texttt{O}\ \texttt{REf}_x ) \rightarrow \neg \texttt{RetryDue}_x \big)
$$

No spurious pulses before any failure.

**RD2 — Uniqueness**
$$
	\texttt{G}\big( \texttt{AtMostOne}(\texttt{REf}_x,\ \texttt{RetryDue}_x) \big)
$$

At most one pulse between consecutive failures (or none if no failure occurs).

**RD3 — Existence**
$$
	\texttt{G}\big( \texttt{REf}_x \rightarrow \texttt{F}\ \texttt{RetryDue}_x \big)
$$

At least one $\texttt{RetryDue}$ tick appears after each failure.

## Nice progress properties (informative)

Following are additional, **informative** assumptions that may hold in some environments. They are not part of the core model.

**A1 - Eventual thawing**

$$
\texttt{G}( \texttt{F}( \neg \texttt{Frozen} ) )
$$

Eventually, the environment provides some positive compute in every future interval.

This rules out permanently freezing environments.
It is a weak form of fairness that ensures the environment does not permanently withhold all compute.

Without this, liveness cannot be satisfied for any scheduler implementation.

**A2 — Starts eventually settle**

$$
\texttt{G}( \texttt{RS}_x \rightarrow \texttt{F}( \texttt{RE}_x \vee \texttt{Crash} ) )
$$

Every callback invocation completes in **finite** time unless pre-empted by $\texttt{Crash}$.
No uniform upper bound is required; the property only rules out infinite executions.
Note that this is not guaranteed - users may write non-terminating callbacks.
That's why this is an **informative** property, not a core property.

But without this property, liveness cannot be satisfied for any scheduler implementation.

**A3 - Low lag**

$$
t_{\texttt{lag}} < 1 \; \text{minute}
$$

If this is true, then whether any task is ever going to be missed is determined purely by $\texttt{compute}$.
A corollary is that if the environment provides enough compute, no tasks are ever missed.

## Environment taxonomy (informative)

The following labels identify illustrative environment classes. They are informative definitions, not global assumptions:

* **Freezing environments:** admit arbitrarily long intervals $(t,u)$ with $\texttt{compute}([t,u]) = 0$.

* **Eventually thawing environments:** there exists $U$ such that every interval of length $\ge U$ supplies some positive compute.

* **Lower-bounded-density environments:** there exist parameters $\varepsilon > 0$ and $\Delta \ge 0$ such that for all $t$ and $T \ge \Delta$, $\texttt{compute}([t,t+T]) \ge \varepsilon\cdot T$ (average density after $\Delta$ never drops below $\varepsilon$).

* **Burst environments:** concentrate density in sporadic spikes; for every $M$ there are intervals of length $> M$ with arbitrarily small compute alternating with brief, high-density bursts.

## Helper Modalities

This section defines the helper modalities $F^{\leq C}_{\texttt{comp}}$ and $F^{\texttt{lin}}_{\texttt{comp}}$ used in the scheduler properties.

**Encodings and bit-length.** Fix a canonical, prefix-free, computable encoding $\llbracket\cdot\rrbracket$ from objects to bitstrings with linear-time decoding. For any object $X$, write $|X| := |\llbracket X \rrbracket|$ for the bit length of its encoding.

**Current registration set and its size.** At any trace position $i$, let $R_i$ be the effective registration set of the most recent initialization that is currently active (that is, the unique $R$ such that $\texttt{Active}_R$ holds at $i$). Write $|R|$ for $|R_i| = |\llbracket R_i \rrbracket|$. *Remark:* any reasonable encoding of a finite map $\texttt{TaskId} \to (\texttt{Schedule}, \texttt{RetryDelay})$ suffices; the spec is parametric in the encoding, assuming only standard per-entry overhead.

**Background time value and its size.** Each position $i$ is associated with a background timestamp value $t := \tau(i) \in \mathbb{T}$. Define $|t| := |\llbracket t \rrbracket|$ using a standard signed binary encoding (so this equals $1 + \lceil \log_2(1 + |t|_{\text{abs}}) \rceil$, where $|t|_{\text{abs}}$ is the absolute value of $t$). *Important:* $|t|$ measures the value of the clock, not the density of events; events may be sparse in $i$ even when $|t|$ grows.

**Compute-bounded eventually.** Fix global non-negative constant $t_{\texttt{lag}}$. For $C \in \mathbb{Q}_{\geq 0}$, the modality

$$
\boxed{\,F^{\leq C}_{\texttt{comp}}(P)\,}
$$

holds at time $i = \tau(i)$ iff there exists $j \geq i$, $U = [i, j]$ and $S \subseteq U$ such that:

- $P$ holds at $j$,
- and $\texttt{compute}(S) \leq C$,
- and $\texttt{duration}(U) - \texttt{duration}(S) \leq t_{\texttt{lag}}$.

Intuitively, this asserts that $P$ will occur after receiving at most $C$ units of environment-provided compute from the current position, plus a small lag $t_{\texttt{lag}}$ to account for a constant delay.

**Linear-in-input compute bound.** Fix global non-negative constants $a, b \in \mathbb{Q}_{\geq 0}$. Define

$$
\boxed{\,F^{\texttt{lin}(X_1, \dots, X_n)}_{\texttt{comp}}(P)\ :=\ F^{\leq\; a\cdot(|X_1|+\dots+|X_n|)+b}_{\texttt{comp}}(P)\,}.
$$

This asserts that $P$ will occur after receiving at most $a \cdot (|X_1|+\dots+|X_n|) + b$ units of environment-provided compute from the current position.

## Theorems

**Theorem1 — Quiescence after Crash**
$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RS} \; \texttt{W} \; \texttt{IE}) )
$$
After $\texttt{Crash}$ no new starts until re-initialisation.
