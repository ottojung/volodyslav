# IncrementalGraph journal

IncrementalGraph stores one replicated journal of immutable precise events. `(author,local sequence)` is event identity and exact same-writer order; sequence has no cross-writer meaning. Every event carries an immutable `causalContext` for cross-writer happened-before. `modifiedAt` or semantic occurrence time resolves causally concurrent changes, and `DatabaseFingerprint` is the deterministic exact concurrent/equal-time tie-break. Events also carry self-contained semantic addresses. A generation records an actual absent-to-present add and establishes value provenance with one explicit initial freshness assertion.

`journalCoverage` proves complete possessed prefixes, `clearsThrough` is validation clearing evidence, reset `absorbsThrough` is intentional source-history absorption, and `ResetCorrespondence` is exact semantic equality evidence. These meanings are distinct. Observed semantic reset copies a semantic projection without importing source journal or source coverage; unseen and concurrent history remains live.

Normative details are in the [types](specs/incremental-graph-journal-types.md), [API](specs/incremental-graph-journal-api.md), [emission](specs/incremental-graph-journal-emission.md), [compaction](specs/incremental-graph-journal-compaction.md), [journal synchronization](specs/incremental-graph-journal-sync.md), [graph synchronization](specs/incremental-graph-synchronization.md), [migration](specs/incremental-graph-journal-migrations.md), and [lifecycle](specs/database-lifecycle.md) specifications.

## Persistent-state boundary

A supported database contains the graph, the single journal, reset-anchor cut summaries, coverage vector,
local counter, causal summary, fingerprint, and related metadata defined by this specification. A
schema-version installation validates its source state and atomically constructs
that complete persistent state. Readers and writers operate only on a fully
installed schema version and MUST NOT interpret a partially constructed or mixed
persistent state.

Production tooling and operational recovery procedures are outside this
specification. The journal subsystem is available only when every component
required by this boundary is present.

## Complexity summary

Let `n` be the number of represented current/historic semantic keys, `r` the
number of represented durable authors, `a` the number of distinct
`(NodeKey,taggedAnchor)` identities whose absorption evidence has been represented, and `c` the number of losslessly
retained full `(key,receiverValueOrigin,sourceGeneration,sourceValueOrigin)`
reset correspondences. Assuming every represented NodeKey/semantic journal
address has bounded serialized size independent of `n`, `r`, `a`, and `c`, and
assuming `n > 0` and `r > 0`, the fully compacted journal together with journal
coverage, causal metadata, and reset-anchor absorption metadata retain `O(nr² + ar + cr)` logical records and vector-coordinate slots.
Public-action, frontier, per-event context, and causal evidence contribute `O(nr²)` such items;
exact correspondence carriers contribute `O(cr)` because each carries an
`O(r)` causal observation vector; one joined `O(r)` cut is retained for each of the `a` exact anchor identities; and coverage's `O(r)` is absorbed by
`O(nr²)` because `r <= nr²`. The `cr` term is necessary when lagging explicitly
certified origins must remain recognizable. The `ar` term is necessary because
an archived cut may outlive every carrier for its exact anchor, and a delayed
concurrent carrier can make that anchor relevant again. Repeated evidence for
one exact anchor collapses componentwise, but `a` may grow independently of
`n`, `r`, and `c`.

This is a logical-item bound, not an unqualified byte-storage bound. Let `b` be
the maximum serialized byte length of any arbitrary-precision journal sequence
or causal coordinate retained in the particular compacted state. Under the
bounded-address premise, serialized journal-plus-coverage size is
`O(b(nr² + ar + cr))` bytes. `b` may grow independently of `n`, `r`, `a`, and `c`, so it
cannot be omitted from a byte bound. Application-owned durable iterator-state strings are not database storage. The bounded-address premise is an asymptotic
assumption, not a runtime size cap.
