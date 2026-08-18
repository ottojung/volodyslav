# IncrementalGraph journal

IncrementalGraph stores one replicated journal of immutable precise events. Its identity is `(sequence,author)`; events carry self-contained semantic addresses and exact actions. Host coverage and consumer progress are independent version vectors. Invalidation mode distinguishes soft stale transitions from hard must-recompute barriers.

Normative details are in the [types](specs/incremental-graph-journal-types.md), [API](specs/incremental-graph-journal-api.md), [emission](specs/incremental-graph-journal-emission.md), [compaction](specs/incremental-graph-journal-compaction.md), [journal synchronization](specs/incremental-graph-journal-sync.md), [graph synchronization](specs/incremental-graph-synchronization.md), [migration](specs/incremental-graph-journal-migrations.md), and [lifecycle](specs/database-lifecycle.md) specifications.

## Implementation/rollout scope

This specification defines the target persistent schema and semantics. Rollout is one coordinated schema-version boundary: implementations must not interpret a database using a mixed model. Before cutover, migration validates the old supported state and atomically constructs graph, the single journal, coverage vector, allocator, fingerprint, and related metadata. After cutover, only the model defined here is readable or writable. No compatibility layer, parallel collection, or dual-write period is part of the design.

Production implementation, deployment ordering, and operational recovery tooling are outside this specification. Until all components implement the complete boundary, the feature remains unavailable rather than partially enabled.

## Complexity summary

Let `n` be represented current/historic semantic keys and `r` represented durable authors in retained evidence or coverage. Exact public-action representatives use `O(nr)` entries and causal validation evidence uses at most `O(nr²)` under bounded-address/context assumptions. Coverage is `O(r)`, so the globally valid bound is `O(nr²+r)`. For `n>0,r>=1` this is `O(nr²)`. For `n=0`, the journal is empty while coverage alone may be `O(r)`. Application-owned `O(r)` cursor strings are not database storage.
