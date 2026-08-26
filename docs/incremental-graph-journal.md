# IncrementalGraph journal

IncrementalGraph stores one replicated journal of immutable precise events. Its identity is `(sequence,author)`; events carry self-contained semantic addresses. A positive GenerationJournalEntry records an actual absent-to-present add and establishes presence/value provenance, and every new generation has one explicit initial freshness assertion. Host coverage and consumer progress are independent version vectors. Invalidation mode distinguishes soft stale transitions from hard must-recompute barriers. Positive and negative freshness evidence is scoped to the selected value origin. Observed-reset lineage summaries absorb only consumed source prefixes, leaving later edits, deletes, and rematerializations live even when receiver Lamport IDs are numerically greater.

Observed semantic reset copies a semantic projection of causally enriched replicated state. To keep that projection stable under later union, reset records causal-prefix evidence for the history it actually consumed; unseen/concurrent history remains live.

Normative details are in the [types](specs/incremental-graph-journal-types.md), [API](specs/incremental-graph-journal-api.md), [emission](specs/incremental-graph-journal-emission.md), [compaction](specs/incremental-graph-journal-compaction.md), [journal synchronization](specs/incremental-graph-journal-sync.md), [graph synchronization](specs/incremental-graph-synchronization.md), [migration](specs/incremental-graph-journal-migrations.md), and [lifecycle](specs/database-lifecycle.md) specifications.

## Implementation/rollout scope

This specification defines the target persistent schema and semantics. Rollout is one coordinated schema-version boundary: implementations must not interpret a database using a mixed model. Before cutover, migration validates the old supported state and atomically constructs graph, the single journal, coverage vector, allocator, fingerprint, and related metadata. After cutover, only the model defined here is readable or writable. No compatibility layer, parallel collection, or dual-write period is part of the design.

Production implementation, deployment ordering, and operational recovery tooling are outside this specification. Until all components implement the complete boundary, the feature remains unavailable rather than partially enabled.

## Complexity summary

Let `n` be represented current/historic semantic keys, `r` durable authors, and `c` losslessly retained full `(key,receiverValueOrigin,sourceGeneration,sourceValueOrigin)` reset correspondences. Retained structural event/vector evidence uses `O(nr²+cr)`: public-action and causal evidence use `O(nr²)`, and each exact correspondence carrier includes an `O(r)` causal observation vector, giving `O(cr)`. Coverage is an additional `O(r)`. The `cr` term is necessary when lagging explicitly certified origins must remain recognizable. For `n=0,c=0`, the journal is empty while coverage may be `O(r)`. Application-owned filter-bound cursor strings are not database storage.

That structural bound is not a serialized-byte bound. If `C` is the maximum serialized size of a represented journal semantic address (`nodeName` plus `bindings`) in the measured state, serialized journal plus coverage size is `O((nr+c)C + nr² + cr + r)`. `C` is neither a global maximum nor an application/runtime size cap.
