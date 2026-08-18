# IncrementalGraph journal emission

Every committed semantic event authors one precise entry in the single journal and atomically advances local clock and coverage. Imports retain identity and never count as authoring.

| decision | precise event |
|---|---|
| absent to materialized | add |
| materialized value changed | edit |
| materialized to absent | delete |
| real fresh-to-stale propagation with reusable proofs | soft invalidate |
| newly established/reasserted must-recompute without an applicable uncovered hard barrier | hard invalidate |
| stale to fresh | validate |

`Unchanged`, identifier/representation changes, copied remote value/provenance, and enforcement of an imported uncovered barrier emit nothing. One causal decision emits one invalidate. Settled hard state is silent.

Every event carries a validated address and generation when scoped. A validation records the complete transaction-visible `invalidateFrontier`, including soft and hard entries, in `clearsInvalidates`. It can become freshness-effective only as one complete context; contexts never combine. A cache-only recovery after soft staleness observes and clears that soft entry. Allocation observes remote maxima and commits graph, event, allocator, coverage, and references atomically.
