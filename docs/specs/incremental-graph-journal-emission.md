# IncrementalGraph journal emission

Every committed semantic event authors one precise entry in the single journal and atomically advances local clock and local coverage. Imported facts are never reauthored merely because they crossed hosts.

| operation | event |
|---|---|
| absent to materialized | add |
| materialized value changed | edit |
| materialized to absent | delete |
| fresh to stale with sufficient reusable proofs | soft invalidate |
| newly established/reasserted must-recompute state | hard invalidate |
| stale to fresh | validate |

`Unchanged`, identifier-only changes, representation changes, and copying remote value/provenance author no edit. One decision that establishes hard invalidation authors only hard mode. Explicit public invalidation may reassert hard mode even stale-to-stale. Ordinary propagated staleness authors soft mode. Settled hard state with an outstanding barrier authors nothing. Normal synchronization never runs a computor and never synthesizes validate.

Every event includes its semantic address and satisfies the key/address invariant. Generation-scoped events name the active add. A validation captures exactly the observed hard frontier in `clearsHardInvalidates`; soft invalidates are excluded. Cache-only recovery after soft-only staleness may therefore validate with an empty context.

Allocation observes durable remote maxima, advances the Lamport clock, and closes skipped values through local coverage. Event, graph transition, clock, coverage, and references commit atomically.
