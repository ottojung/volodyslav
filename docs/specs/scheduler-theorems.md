
# Scheduler Theorems

This file contains theorems that can be derived from the axioms in [scheduler-theory.md](scheduler-theory.md).
More specifically, statements in this file follow from $T_{\textsf{env}} \cup T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$.

---

## Theorem 1 — Quiescence after Crash

$$
\texttt{G}( \texttt{Crash} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IEs}) )
$$

After $\texttt{Crash}$ no new starts until re-initialisation. Uses environment axioms EA1, EA2, and EA6.

---

## Theorem 2 — Per-task non-overlap

$$
\texttt{G}\big( \texttt{RS}_x \rightarrow \neg \texttt{Y} \;\texttt{Running}_x \big)
$$

Once a run starts, no further $\texttt{RS}_x$ may occur before a matching $\texttt{RE}_x$ or $\texttt{Crash}$. Derived from **S1** together with the definition of $\texttt{Pending}$.

---

## Theorem 3 — Quiescence after StopEnd

$$
\texttt{G}( \texttt{SE} \rightarrow (\neg \texttt{RS}_x \; \texttt{W} \; \texttt{IEs}) )
$$

After $\texttt{SE}$, no new starts until re-initialisation. Derived from **S1** and the fact that $\texttt{Obligation}$ requires $\texttt{Active}$.

---

## Theorem 4 — Crash dominance

$$
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{RS}_x ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{RE}_x ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{IS}_R ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{IE} ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{SS} ) \\
\texttt{G}( \texttt{Crash} \rightarrow \neg \texttt{SE} ) \\
$$

A crash cannot cooccur with any action. Derived from **EA1** and **EA2**.

---

## Theorem 5 — Example Theorem of Traces

The following are traces of $T_{\textsf{env}} \cup T_{\textsf{sch}}(a,b,t_{\texttt{lag}})$:

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
RetryDue_1      // RetryDue_1 occurs at t_f + RetryDelay(1); eligibility becomes true then
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
