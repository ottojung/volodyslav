
# Formal Model of Scheduler's Observable Behavior

---

This model combines first-order quantification over the universe scheduler objects with **future- and past-time LTL** formulas. Atomic predicates below are predicate symbols parameterised by a scheduler object variable (for example, $\texttt{RS}_x$, $\texttt{InitEnd}(R)$), and temporal operators apply to propositional formulas obtained by instantiating those predicates for concrete objects.

We use the convenient shorthand of writing instantiated propositions like $\texttt{RS}_x$ for $\texttt{RunStart}(x)$. Where a formula is stated without explicit quantifiers, the default intent is universal quantification (eg. “for all tasks x”). First-order quantification ranges over the set of scheduler objects; temporal operators reason over event positions in the trace.

This model focuses on externally observable behaviour, but does not include the error-handling part.

## Relation to the Environment Model

The scheduler model is parametric in an external execution environment ($\mathcal{E}$) (see [Execution Environment Model](#execution-environment-model)).

The environment supplies exogenous phenomena and background structure: crash instants (the $\texttt{Crash}$ predicate), the real-time axis and clock alignment used by cron ($\mathbb{Z}$ time, minute boundaries), and retry pulses ($\texttt{RetryDue}_x$). It also constrains progress via a compute density function.

We split the models to separate scheduler obligations/choices (this section) from assumptions about the host and world (environment). This keeps safety properties independent of the host and makes progress claims explicit about their environmental preconditions (see [Environment taxonomy](#environment-taxonomy-informative)).

# Modelling Framework

* **Trace semantics:** Each trace position corresponds to an instant where an observable event occurs. Events that are simultaneous appear at the same integer time points. Time bounds are background semantics only (not encoded in LTL).
* **Logic:** A combination of first-order quantification (over tasks) and **LTL with past**.

  * **Future operators:** $\texttt{G}$ (□), $\texttt{F}$ (◊), $\texttt{X}$ (next), $\texttt{U}$ (until), $\texttt{W}$ (weak until).
  * **Past operators:** $\texttt{H}$ (historically), $\texttt{O}$ (once), $\texttt{S}$ (since), $\texttt{Y}$ (previous).
  * We prefer the **stutter-invariant** past operators ($\texttt{S}$, $\texttt{H}$, $\texttt{O}$) in this spec.

# Definitions

This subsection gives a signature-based, self-contained definition of the model, followed by interpretations of each symbol.

## Time and Traces

* **Time domain:** $\mathbb{Z}$ (integer numbers), used to timestamp observable instants, no initial event. Time and “minute boundaries” are interpreted using the host clock as provided by the environment (see [Execution Environment Model](#execution-environment-model)).
* **Trace:** a sequence of positions $i = 0, 1, 2, \dots$ with a timestamp function $\tau(i) \in \mathbb{Z}$ that is non-strictly increasing. At each position $i$, one or more observable events may occur.

## Domains

* $\texttt{TaskId}$ — a finite, non-empty set of task identifiers.
* $\texttt{Result} = \{ \texttt{success}, \texttt{failure} \}$.
* $\texttt{RegistrationSet}$ — a finite mapping $R : \texttt{TaskId} \to (\texttt{Schedule}, \texttt{RetryDelay})$.
* $\texttt{Schedule}$ — an abstract predicate $\texttt{Due}(\texttt{task}: \texttt{TaskId}, t: \mathbb{Z}) \to \texttt{Bool}$ indicating minute-boundary instants when a task is eligible to start.
* $\texttt{RetryDelay} : \texttt{TaskId} \to \mathbb{Z}_{\geq 0}$ $-$ the function that maps each task to its non-negative retry delay.

**Interpretation:**
$\texttt{TaskId}$ names externally visible tasks. A $\texttt{RegistrationSet}$ is the public input provided at initialization. $\texttt{Due}$ and $\texttt{RetryDelay}$ are parameters determined by the registration set and the environment (host clock); they are not hidden internal state. Time units for $\texttt{Due}$ and $\texttt{RetryDelay}$ coincide.

## Event Predicates (Observable Alphabet)

Each event predicate is evaluated at a trace position $i$ (we omit $i$ when clear from context):

* $\texttt{InitStart}$ — the JavaScript interpreter calls `initialize(...)`.
* $\texttt{InitEnd}(R)$ — the `initialize(...)` call returns; the effective registration set is $R$.
* $\texttt{StopStart}$ — the JavaScript interpreter calls `stop()`.
* $\texttt{StopEnd}$ — the `stop()` call returns.
* $\texttt{UnexpectedShutdown}$ — an unexpected, in-flight system shutdown occurs (e.g., process or host crash). This interrupts running callbacks and preempts further starts until a subsequent $\texttt{InitEnd}$. This predicate is supplied by the environment’s crash generator.
* $\texttt{RunStart}(x)$ — the scheduler begins invoking the public callback for task $x$.
* $\texttt{RunEnd}(x, r)$ — that invocation completes with result $r \in \texttt{Result}$.

* $\texttt{Due}_x$ — is start of a minute that the cron schedule for task $x$ matches.

  *Interpretation:* the cron schedule for $x$ matches the current minute boundary.
  Minute boundary is defined as the exact start of that minute.

  For example, for a cron expression `* * * * *`, a minute boundary occurs at `2024-01-01T12:34:00.00000000000000000000000000000000000000000000000000000` (infinitely many zeros) local time.

  Time is defined by the host system's local clock (see [Execution Environment Model](#execution-environment-model)).

* $\texttt{RetryDue}_x$ — is the instant when the backoff for the most recent failure of $x$ expires.

  *Interpretation:* is a primitive point event (like $\texttt{Due}_x$), supplied by the environment/clock. If the latest $\texttt{RunEnd}(x,\texttt{failure})$ occurs at time $t_f$, then $\texttt{RetryDue}_x$ holds at time $t_f + \texttt{RetryDelay}(x)$. These pulses are truths about the environment.

Each predicate marks the instant the named public action occurs from the perspective of the embedding JavaScript runtime: function entry ($\texttt{InitStart}$, $\texttt{StopStart}$), function return ($\texttt{InitEnd}$, $\texttt{StopEnd}$), callback invocation begin/end ($\texttt{RunStart}$, $\texttt{RunEnd}$), and exogenous crash ($\texttt{UnexpectedShutdown}$). No logging or internal bookkeeping is modeled.

## Macros

#### Abbreviations

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

#### Input predicates

* $IE^{\text{in}}_x := \exists R.\,(\texttt{InitEnd}(R)\wedge x\in\text{dom}(R))$

  *Interpretation:* membership of $x$ in the registration set provided at the most recent initialization.

* $IE^{\text{out}}_x := \exists R.\,(\texttt{InitEnd}(R)\wedge x\notin\text{dom}(R))$

  *Interpretation:* non-membership of $x$ in the registration set provided at the most recent initialization.

* $\texttt{Registered}_x := \texttt{Hold}(IE^{\text{in}}_x,\; IE^{\text{out}}_x)$

  *Interpretation:* membership of $x$ in the most recent observed registration set.

* $\texttt{RetryEligible}_x := \texttt{Hold}(\texttt{RetryDue}_x,\ \texttt{REf}_x)$

  *Interpretation:* before any failure of $x$ has completed, retries are allowed (eligible). After a failure completes, eligibility becomes true at the first $\texttt{RetryDue}_x$ pulse since that failure and remains true until cleared by a subsequent failure.

---

#### Stateful

* **Hold-until-clear**

$$
\texttt{Hold}(\texttt{set}, \texttt{clear}) := (\neg \texttt{clear}) \; \texttt{S} \; \texttt{set}
$$

There was a $\texttt{set}$ in the past (or now), and no $\texttt{clear}$ since.

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

# Liveness Properties (normative)

These properties state progress guarantees.
They prevent deadlocks, starvation, livelocks, and unbounded postponement of obligations.

Progress is always read relative to the environment’s willingness to provide compute. In fully freezing environments (see [Environment taxonomy](#environment-taxonomy-informative)), obligations may accumulate without violating safety; in eventually thawing or lower-bounded-density environments, the fairness assumptions below become reasonable or derivable premises for liveness. In other words, in some environments, it is impossible to implement a scheduler.

**L1 — Obligation fulfillment**

$$
\texttt{G}( (\texttt{Active} \wedge \texttt{Registered}_x \wedge \texttt{EffectiveDue}_x) \rightarrow \texttt{F} (\texttt{RS}_x \vee \neg \texttt{Active} ) )
$$

When a task is supposed to be executed, we must eventually see $\texttt{RS}_x$ (or a $\texttt{Crash}$, or $\texttt{SE}$, which reset obligations).

**L2 — Stop terminates**
$$
\texttt{G}( \texttt{SS} \rightarrow \texttt{F} \; \texttt{SE} )
$$

**L3 — Initialization completes**
$$
\texttt{G}( \texttt{IS} \rightarrow \texttt{F} \; \texttt{IE} )
$$

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
\texttt{G}( \texttt{RS}_x \rightarrow ( \texttt{Active} \wedge \texttt{Registered}_x \wedge \texttt{EffectiveDue}_x ) )
$$
A start can occur only while active, registered, and there is a current obligation to run.

**S3 — Conservation of starts**

$$
\texttt{G}( \texttt{AtMostOne}(\texttt{Due}_x, \texttt{REs}_x) )
$$

Should not start a task more than once for the same due period unless it fails.

Looking directly, this is a restriction on the number of successful **completions** per due period, not starts. However, the possibility that the callback will return before the next due period prevents the scheduler from starting the task again in that same period. Thus, the restriction on successful completions indirectly restricts starts.

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

The environment contributes two orthogonal ingredients:

1. **Crash generator** — a predicate $\texttt{Crash}(t)$ over $\mathbb{Z}$. When true, the environment marks an exogenous interruption that preempts in-flight callbacks and halts the scheduler itself; property **E1** enforce the resulting quiescence in the trace.

2. **Work density function** — a dimensionless function

   $$
   \texttt{compute} : \mathbb{Z} \times \mathbb{Z} \to \mathbb{Q}_{\ge 0}
   $$

   assigning the potential amount of computational progress available over any real-time, open interval $(t,u)$. It satisfies, for all $t \le u \le v$:

   * **T1 (identity):** $\texttt{compute}(t,t) = 0$.
   * **T2 (additivity):** $\texttt{compute}(t,v) = \texttt{compute}(t,u) + \texttt{compute}(u,v)$.
   * **T3 (monotonicity & nonnegativity):** $\texttt{compute}(t,u) \ge 0$ and $\texttt{compute}(t,u) \le \texttt{compute}(t,v)$.

   No positivity is assumed; the environment may set $\texttt{compute}(t,u) = 0$ on arbitrary (even unbounded) intervals, modelling **freezes** where no work can progress. We write $\texttt{Frozen}(t,u)$ when $\texttt{compute}(t,u) = 0$. We write $\texttt{Frozen}$ at a trace position $i$ when $\texttt{Frozen}(\tau(max(0, i-1)), \tau(i+1))$. This means no work progressed in the interval surrounding the trace position.

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

**E3 - Ends require work**

$$
\texttt{G}( \texttt{RE}_x \rightarrow \neg \texttt{Y} ( \texttt{Frozen} ))
$$

Ending a run requires that some work has been spent on it.

**E4 - Unlimited dues**

$$
\texttt{G} \; \texttt{F} \; \texttt{Due}_x
\\
\texttt{H} \; \texttt{O} \; \texttt{Due}_x
$$

For every task $x$, the cron schedule matches infinitely often, in both directions.

**E5 - Due pointness**

$$
\texttt{G}( \texttt{Due}_x \rightarrow \neg \texttt{X}(\texttt{Due}_x) )
$$

No two $\texttt{Due}_x$ events are simultaneous.

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

**RD4 — First-after-last-failure**
$$
	\texttt{G}\big( \texttt{RetryDue}_x \rightarrow ( \neg \texttt{RetryDue}_x \ \texttt{S} \ \texttt{REf}_x ) \big)
$$

This associates each pulse to the most recent failure.

*Notes:*  
- **RD2** + **RD4** ensure any previously scheduled pulse is ``canceled'' by a subsequent failure; at most one $\texttt{RetryDue}_x$ can occur in the epoch since the last $\texttt{REf}_x$, and if it occurs, it is the first in that epoch.  
- **RD3** guarantees progress of backoff timers.

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

## Environment taxonomy (informative)

The following labels identify illustrative environment classes. They are informative definitions, not global assumptions:

* **Freezing environments:** admit arbitrarily long intervals $[t,u)$ with $\texttt{compute}(t,u) = 0$.

* **Eventually thawing environments:** there exists $U$ such that every interval of length $\ge U$ supplies some positive compute.

* **Lower-bounded-density environments:** there exist parameters $\varepsilon > 0$ and $\Delta \ge 0$ such that for all $t$ and $T \ge \Delta$, $\texttt{compute}(t,t+T) \ge \varepsilon\cdot T$ (average density after $\Delta$ never drops below $\varepsilon$).

* **Burst environments:** concentrate density in sporadic spikes; for every $M$ there are intervals of length $> M$ with arbitrarily small compute alternating with brief, high-density bursts.
