# IncrementalGraph Journal 2

## Status and scope

This specification is the entry point for Journal 2. It is normative together with:

- `incremental-graph-journal-types.md`
- `incremental-graph-journal-emission.md`
- `incremental-graph-journal-projection.md`
- `incremental-graph-journal-sync.md`
- `incremental-graph-journal-compaction.md`
- `incremental-graph-journal-api.md`
- `incremental-graph-journal-reset.md`
- `incremental-graph-journal-migrations.md`
- `incremental-graph-journal-locking.md`
- `incremental-graph-synchronization.md`

Journal 2 adds one new IncrementalGraph sublevel, `journal`. It does not change the representation of any existing sublevel.

The conceptual journal is a local ordered history of events. The persisted journal may be compacted into bounded per-node summaries and indexes which preserve the future synchronization and iterator semantics specified below.

The journal is not a durable audit log. Canonical compaction may permanently discard old raw events and high-level operation-grouping detail once their required future synchronization/iterator meaning has been retained in bounded journal state.

## Design boundary

The existing graph representation remains the operational representation:

```text
identifiers_keys_map
values
freshness
timestamps
valid
...
```

No version, causal, provenance, journal, cursor, or synchronization-only field is added to those records. Journal 2 is a sidecar which supplies information that the existing representation cannot express.

In particular, the journal can distinguish two occurrences of equal `ComputedValue` payloads without comparing those payloads, identify the exact input value occurrences against which a cache was certified, and retain negative authority after a materialization has been deleted from the legacy graph.

The journal never stores a `ComputedValue` payload or a copy of one. A current present journal state therefore requires the corresponding payload and timestamp record to exist in the unchanged legacy sublevels.

## Local journals

Every writable database has one durable journal writer identity, normally its `DatabaseFingerprint`. Journal semantic events authored by that database have writer-local history and a monotonically increasing writer-local semantic event sequence.

Journal 2 deliberately does **not** make sequence magnitudes globally comparable. Event identity, exact causality, and conflict authority are separate:

```text
JournalEventId(author, localSequence)   // writer-local identity
CausalPrefix                           // exact happened-before
AuthorityTime                          // HLC conflict precedence
```

A local event gets `localSequence + 1` regardless of remote sequence magnitudes. Exact causal observation is represented by the vector context. Deterministic conflict authority is represented by a hybrid logical clock which extends happened-before and is seeded from legacy `modifiedAt` for value occurrences.

For concurrent authorities, the total order compares causality-adjusted authority time, then writer fingerprint, then writer-local sequence. The final sequence comparison therefore occurs only within one writer.

Normal synchronization does not import source event history into the receiver journal. It may adopt foreign semantic references and bounded foreign metadata into receiver summaries. If this changes receiver state, the receiver records a local adoption event so its own change stream reflects the transition. The adoption event is not a new value occurrence and does not replace or inflate the adopted foreign semantic authority.

Thus:

```text
source journal history != receiver journal history
```

while their graph projections may converge.

## High-level operations and low-level semantic events

Journal 2 records synchronization authority with low-level semantic events such as value, validate, invalidate, delete, and adopt.

It also permits the local historical journal to preserve the identity of the high-level operation which produced those events. A high-level operation gets a small local tagged `OperationRecord`; low-level events produced by it carry that operation ID.

The operation record includes the bounded arguments needed to identify the invocation itself. For example:

```text
pull(K)                   -> subject = K
invalidate(K)             -> subject = K
synchronize(S@I:Q,C,H)    -> source writer/incarnation/local head/causal summary/HLC high-water
reset(S@I:Q,C,H)          -> chosen source writer/incarnation/local head/causal summary/HLC high-water
migration(M)              -> stable MigrationId M
```

For Journal 2 sources, `Q` alone is not enough to identify the synchronization-relevant source state because its causal summary `C` and authority high-water `H` may grow without authoring a new local semantic event. Source-bearing operation records therefore retain all of those bounded source-header fields from the fixed snapshot they consumed.

When a lifecycle source has no Journal 2 metadata, reset can still record its durable database identity while omitting Journal 2 position fields.

Conceptually this permits viewing the **direct expansion** of one operation as:

```text
graph.pull K {
    compiled: [
        value(...),
        validate(...),
        invalidate(...)
    ]
}
```

Here `compiled` means the low-level events directly produced under that operation ID. If `pull(K)` recursively invokes another pull, that nested pull may have its own operation ID and its events need not appear in the parent operation's expansion. Journal 2 therefore does not promise one transitive envelope containing every recursively caused event.

A child operation may optionally record `parent: OperationId` for its direct high-level caller. This is only a bounded historical edge; parents never enumerate child lists, and the parent relation has no synchronization or causal authority.

The `compiled` array above is only a conceptual view: it is not stored as one large LevelDB value. The expansion is represented by the list of small low-level events that point to the operation ID.

Operation IDs use a separate local counter and do not participate in semantic authority, causal context, conflict selection, synchronization, or projection. Therefore preserving high-level operation identity cannot change graph semantics merely by changing event-number allocation.

Compaction may discard old operation grouping together with the raw events it described once only the bounded synchronization meaning remains relevant.

## Two layers inside the journal sublevel

The journal sublevel contains two conceptual layers.

### Historical layer

The historical layer contains locally authored high-level operation records and low-level semantic events in journal history. Before compaction this is the direct history of supported graph operations and synchronization transitions.

Operation records group semantic events but do not replace them as synchronization authority.

### Compacted synchronization layer

Compaction folds old history into bounded records:

```text
header {
    local counters,
    causalSummary,
    authorityClock,
    ...
}
node summary per represented NodeKey
one current changed-node marker per represented NodeKey
optional bounded un-compacted history tail
stored source cursors
```

These records are journal information, not changes to the legacy graph representation. A compacted node summary is the future-relevant meaning of the historical events for that node; it is not a `ComputedValue` store.

## Core invariants

### J2-INV-1: graph/journal consistency

For every supported persisted database state, the legacy materialized graph must equal the journal projection defined in `incremental-graph-journal-projection.md`, modulo local physical identifier choices explicitly excluded there.

A present journal value occurrence must correspond to exactly one materialized semantic node in the legacy graph. An absent journal state must not have a materialized legacy node.

### J2-INV-2: atomic publication

A transaction which changes legacy graph state and corresponding journal state publishes both atomically. A transaction may also change synchronization-only journal metadata without changing legacy graph state, but such metadata must never describe a graph transition which was not durably published.

High-level operation records and low-level semantic events belonging to one committed graph transition must obey the same publication boundary.

### J2-INV-3: no payload duplication

Journal keys and values contain no `ComputedValue` payload. Historical payloads are not reconstructible from the journal after the corresponding legacy value has been replaced or deleted.

### J2-INV-4: stable semantic references

A semantic value occurrence has one immutable `ValueId` and one immutable `ValueRef` context/authority time. Normal synchronization preserves all of those fields when the value is copied between databases. Receiver-local adoption event IDs do not become new `ValueId`s.

A successful local computation which changes the semantic value creates a new `ValueId`. A successful computation or cache revalidation which returns the existing semantic value preserves its `ValueId` and original value authority and creates only a new validation certificate.

### J2-INV-5: causality-respecting deterministic authority

Semantic value/delete authorities and validation certificates have the deterministic total EventRef order specified in the types specification.

Event allocation guarantees:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

The HLC order is a conflict-resolution device. Exact causal tests still use explicit vector context; HLC comparison is not used to infer happened-before.

Writer-local journal sequences from different authors are not compared for conflict precedence. Writer fingerprint is the cross-host deterministic tie-break after HLC authority time.

High-level operation IDs are excluded from this authority order.

### J2-INV-6: bounded current meaning

Let:

```text
L = currently present/materialized represented keys
T = retained absent/tombstoned represented keys
N = L + T
```

After canonical compaction, each represented semantic key has only a constant number of future-relevant journal records, each of serialized size `O(R log H)` bits under the assumptions in `$id-jtwosizebd`.

Consequently the complete compacted journal has serialized size:

```text
O((L + T) R log H) bits
= O(N R log H) bits
```

`T` may grow with historical unique-key churn. The bound is a pessimistic worst-case bound and does not rely on remote-host acknowledgements or eventual return.

The proof is in `incremental-graph-journal-compaction.md`.

## Supported lifecycle

Correctness guarantees apply to states produced by supported Journal 2 authoring, synchronization, migration, reset, same-host restoration, and canonical compaction. Corrupt, forged, rolled-back, partially installed, or identity-colliding states are outside the semantic model and must be rejected where practical rather than assigned invented meaning.

A same-host first-boot restoration resumes the exact previously published Journal 2 writer state, including writer-local counters, incarnation, causal summary, authority-clock high-water mark, node summaries, and valid saved cursors. It does **not** mint a reset baseline merely because local live files were absent. Arbitrary rollback to an older same-writer snapshot which could reuse already-published event IDs or move the authority clock backward is unsupported.

Controlled reset is different: it intentionally replaces an already-established logical database, increments the local journal incarnation, deletes receiver-local source cursors, and mints a fresh reset baseline as specified by `incremental-graph-journal-reset.md`.

## Full sync before incremental sync

The normative semantic synchronization operation is full synchronization. It scans the complete current journal/graph semantic domain and does not require cursors.

The journal change index and cursor API are an optimization. For a valid cursor, incremental synchronization must be observationally equivalent to the full operation from the same source and receiver states.

A receiver reset explicitly clears stored source cursors because replacing receiver state destroys the invariant those cursors certify. Incremental synchronization also acquires any required source payload/timestamp records from the same fixed source snapshot as the metadata delta and transfers both source causal and HLC authority header high-water state.

If synchronization cannot establish that a selected cached materialization is safe to expose later as `oldValue`, it may discard that cache and any dependent caches that cannot remain dependency-closed, while preserving negative authority against resurrection of the rejected occurrence. Cache retention is subordinate to `oldValue` safety.

## Transport independence

Git branches, hashes, commits, repository ancestry, checkpoint names, and transport ordering do not participate in journal identity or semantics. They may transport stable snapshots, but all journal reasoning uses only Journal 2 state and the IncrementalGraph schema.
