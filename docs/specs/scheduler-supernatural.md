
# Motivation

## Real-World Assumptions and the Limits of Conformance

This section is informative. It clarifies the boundary between the mathematical model and the physical world by acknowledging conditions under which **no real-world implementation can be conformant**, regardless of design choices.

### Conformance is Relative to the Modelled World

Conformance is evaluated over traces of the signature $\Sigma_{\textsf{env}}\cup\Sigma_{\textsf{sch}}$ that satisfy the combined theory $T_{\textsf{env}}\cup T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$. The model admits **only** the phenomena expressible in that signature and governed by the axioms (e.g., $\texttt{Crash}$, $\texttt{Due}$, $\texttt{RetryDue}$, compute density). Physical phenomena that alter an implementation's behavior **without** being represented as events/functions in the signature are **outside** the model.

**Unmodelled-perturbation principle.** If a physical phenomenon can (i) alter the scheduler's future scheduler-owned actions or its ability to meet compute-bounded eventualities, while (ii) producing no corresponding change in the modelled environment tuple $\mathcal{E}$ or permitted actions, then there exist executions where the projection to $\Sigma_{\textsf{env}}\cup\Sigma_{\textsf{sch}}$ **must** violate at least one of S1–S4 or L1–L3. In such worlds, **conformance is unattainable**.

### Two Witnesses of Unattainability

1. **Crash + non-recoverable storage loss.**
   Consider a prefix where:

$$
\begin{align*}
&\bullet \; \texttt{REf}_x \text{ holds at time } t_f \text{ (a failure of task } x \text{),} \\
&\bullet \; \text{hence } \texttt{RetryDue}_x \text{ holds at } t_f+\textsf{rd}(x) \text{ (environment pulse),} \\
&\bullet \; \text{and } x \text{ remains registered and not running.}
\end{align*}
$$

By definition, $\texttt{RetryPending}_x$ holds thereafter until cleared by $\texttt{RS}_x$ or $\texttt{FirstComing}_x$. Now let a $\texttt{Crash}$ occur. In the theory, $\texttt{Crash}$ clears $\texttt{Active}_R$ but **does not erase the past**; the trace still encodes the earlier $\texttt{REf}_x$ and $\texttt{RetryDue}_x$, so after any subsequent successful $\texttt{initialize}(R)$ the macros reconstruct $\texttt{Pending}_x$ and thus $\texttt{Obligation}_{R,x}$ at the first post-quiescent instant when $R$ is active again.

In a physical world where the crash is followed by **irrecoverable loss of all persistent scheduler state** (e.g., drive failure that wipes the data needed to reconstruct pre-crash obligations), the implementation **cannot know** that $\texttt{RetryDue}_x$ has occurred or that $\texttt{REf}_x$ preceded it. Nevertheless, the **spec's obligation is computed from the trace**, not from the implementation's memory. L1 requires that, once $R$ is active again and the environment grants sufficient compute, we eventually observe $\texttt{RS}_x$ within $F^{\texttt{lin}}_{\texttt{comp}}$—but the implementation lacks the information to meet that bound.

2. **Single-event upsets (cosmic rays) in RAM/CPU state.**
   A single bit flip in memory or a transient logic fault can arbitrarily perturb the control path of the scheduler at an instant that is not represented by any event in $\Sigma_{\textsf{env}}$. Such a perturbation can, for example,

$$
\begin{align*}
&\bullet \; \text{cause a spurious } \texttt{RS}_y \text{ when } \texttt{Obligation}_y \text{ is false (violating } \textbf{S1} \text{), or} \\
&\bullet \; \text{cause two } \texttt{RSucc}_x \text{ between consecutive } \texttt{Due}_x \text{ pulses (violating } \textbf{S2} \text{), or} \\
&\bullet \; \text{prevent } \texttt{RS}_x \text{ within the } F^{\texttt{lin}}_{\texttt{comp}} \text{ budget (violating } \textbf{L1} \text{).}
\end{align*}
$$

Because the model provides no primitive to represent "bit-flip inside the scheduler's internal state" (and because such a flip need not manifest as $\texttt{Crash}$ or $\texttt{Frozen}$), the resulting deviation **cannot be re-expressed** as a permitted environment behavior.

**Additional examples** include silent memory corruption, undetected CPU faults, clock rollback outside the semantics of $\texttt{Due}$, and OS/VM anomalies that arbitrarily suppress or duplicate scheduler actions without surfacing as $\texttt{Crash}$ or $\texttt{compute}$ effects.

---
