# IncrementalGraph Journal 3

## Status and scope

Journal 3 is the append-only replay log for IncrementalGraph state.

The journal is the semantic source of truth. The existing IncrementalGraph persistence remains the efficient materialized representation used by the runtime, but its semantic contents are derived from Journal 3 rather than carrying independent synchronization authority.

This branch specifies the journal itself and its integration with IncrementalGraph. It intentionally does **not** specify a concrete remote/backend product protocol and does not redefine how an existing transport such as Git discovers or carries a stable journal snapshot.

The Journal 3 specification is split by responsibility:

- `incremental-graph-journal-types.md` — record identities, event shapes, causal context, authority ordering;
- `incremental-graph-journal-well-formedness.md` — cross-record/reference validity;
- `incremental-graph-journal-replay.md` — deterministic projection from retained history to the legacy graph representation;
- `incremental-graph-journal-emission.md` — mapping ordinary graph transitions to journal records;
- `incremental-graph-journal-locking.md` — integration with the existing graph locking/publication model;
- `incremental-graph-journal-api.md` — internal/public software-facing boundaries, stable snapshots, and error/result semantics;
- `incremental-graph-journal-sync.md` — history replication and synchronization normalization;
- `incremental-graph-journal-reset.md` — append-only controlled reset/rebaseline;
- `incremental-graph-journal-migrations.md` — initial bootstrap, whole-format rewrite, and later replay-complete migrations;
- `incremental-graph-journal-theorems.md` — correctness laws/proof obligations;
- `incremental-graph-journal-examples.md` — worked semantic traces.

Replay checkpoints may be added later as derived accelerators. They are not required for correctness and never replace authoritative history.

## Fundamental model

A Journal 3 database has one durable writer identity:

```text
JournalAuthor = DatabaseFingerprint
```

Each author owns one append-only semantic stream:

```text
A:1, A:2, A:3, ...
B:1, B:2, B:3, ...
C:1, C:2, C:3, ...
```

A local database may retain prefixes of many writer streams.

A writer may create new records only under its own identity. Synchronization copies foreign records verbatim within one compatible current database version; it does not rename, summarize, or re-author them merely because another database learned them.

The retained history is therefore conceptually:

```text
JournalReplica = Map<JournalAuthor, contiguous prefix>
```

with frontier:

```text
JournalFrontier = Map<JournalAuthor, JournalSequence>
```

A missing coordinate means zero.

Example:

```text
{
    A: 417,
    B: 93,
    C: 51
}
```

means records `A:1..417`, `B:1..93`, and `C:1..51` are retained.

A supported retained frontier is causally closed: if a semantic event claims to have observed another writer through q, that writer's records through q are also retained.

## One current persisted format

The current replica's existing `global/version` selects the representation of the entire replica, including Journal 3 records and journal-derived metadata.

Journal records do not carry independent version stamps. A supported active replica contains only its current-version journal representation, and ordinary open/replay/synchronization does not upcast/downcast individual historical records.

When a database version changes the journal representation, migration constructs an inactive target and rewrites every retained record into the target canonical format before cutover. Existing `(author,sequence)` identities and historical semantic/causal/reference meaning are preserved. The old active and new inactive replicas may temporarily use different versions; each replica individually remains homogeneous.

Whole-journal migration time/I/O is an explicit accepted trade-off for this simplicity.

## Journal-first state

For one compatible current database/schema interpretation define:

```text
project(J) = persisted IncrementalGraph state determined by replay of J
```

The central Journal 3 law is:

```text
currentGraph == project(retainedJournal)
```

This is a reconstruction/determinism requirement, not mathematical injectivity from history to current graph.

Different histories may legitimately end in the same graph state. The required direction is:

> the journal contains every semantic fact necessary to determine the graph, while the graph contributes no additional semantic fact that replay would need to guess.

A supported implementation must therefore be able to discard the materialized graph and rebuild an observationally equivalent one from retained journal history under the compatible current schema/version interpretation.

## Core invariants

### J3-INV-1: replay completeness

For every supported committed Journal 3 database:

```text
semanticGraph(persistedGraph)
    == semanticGraph(project(retainedJournal))
```

Replay determines at least:

- which semantic nodes are materialized;
- selected current `ValueId`s;
- exact `ComputedValue` payloads;
- selected physical `NodeIdentifier`s;
- `createdAt` and `modifiedAt`;
- freshness;
- semantic validity edges;
- receiver-local allocation watermark through writer-state history.

The existing `identifiers_keys_map`, `values`, `timestamps`, `freshness`, `valid`, and local `last_node_index` are a lowering/materialization of these replay facts plus current schema-derived structure.

### J3-INV-2: no independent graph authority

No persisted graph sublevel may contain synchronization/semantic authority absent from the retained journal.

A graph/journal mismatch is unsupported/corrupt state or derived-state damage. It is not resolved by preferring the mutable graph over history.

A repair/rebuild procedure may recreate graph/index state from valid history, but it may not invent missing journal semantics from the graph once Journal 3 is established.

### J3-INV-3: immutable journal identity and historical meaning

Once `(author, sequence)` is durably published, that ID's historical semantic fact never changes and the record is not destructively removed by Journal 3 maintenance.

A supported writer stream is a contiguous prefix from 1. There are no durable holes, and database migration must not insert/remove/renumber pre-existing coordinates.

A database-version migration may rewrite the physical/current-format representation of an existing record, but only deterministically while preserving its ID, historical meaning, authority/causal fact, and cross-record references.

Derived indexes/checkpoints may be rebuilt or deleted. Authoritative historical facts may not.

### J3-INV-4: one continuing writer stream per writer identity

Only writer A may create new A-authored records.

Foreign replicas may retain and relay A's records.

If a writable A database discovers a longer exact prefix of its own A stream, it may recover/import that suffix under exclusive maintenance and continue authoring strictly after the recovered head.

If two same-version copies disagree on any overlapping A record, A's history has forked or storage is corrupt; the disagreement is rejected rather than merged.

Two independently live writable installations intentionally sharing one `DatabaseFingerprint` are outside the supported lifecycle. Accidental independently-created fingerprint collision is the explicit accepted negligible-risk trade-off recorded elsewhere.

### J3-INV-5: causal closure

Every retained semantic event context is covered by the retained frontier.

For E and writer A:

```text
E.context[A] <= retainedFrontier[A]
```

Staging may temporarily receive records out of order, but unsupported partial history is not exposed as an active committed journal/projection.

### J3-INV-6: atomic journal/projection publication

Whenever a supported operation appends/imports journal history and changes the materialized graph, history and matching projection become durable/active together.

There is no supported observation point containing:

```text
new journal + old graph
```

or:

```text
old journal + new graph
```

Ordinary graph transactions use the per-replica commit boundary. Synchronization/reset/migration may build inactive targets and cut over under exclusive maintenance.

### J3-INV-7: deterministic replay

For one compatible current interpretation and one supported causally closed current-format journal J:

```text
project(J)
```

is deterministic.

Arrival order, filesystem layout, inactive replica names, and transport IDs do not change replay of that fixed retained J.

This does not imply that two different historical executions which actually authored different semantic normalization events must have the same J or projection.

### J3-INV-8: replay performs no historical external work

Replay never calls computors and never reruns historical reset/migration/synchronization/application operations.

Replay must not depend on current wall time, randomness, network services, or ambient application state.

Historical nondeterministic outcomes are data in records. A `ValueEvent` carries the actual payload produced historically.

### J3-INV-9: validation history is self-describing

A `ValidateEvent` identifies each semantic input explicitly:

```text
{
    input: NodeKey,
    value: ValueId | "unknown"
}
```

Basis input NodeKeys are unique and entries are serialized by canonical persisted `NodeKeyString` lexicographic order, independent of graph-schema input enumeration order.

Known ValueIds are causally prior occurrences of the named semantic input. `"unknown"` is allowed only in controlled bootstrap/reset/migration baselines.

Current replay uses a certificate as current structural proof only when its explicit input-key set equals the current node's distinct direct-input set. Thus old certificates remain intelligible history across schema evolution without future software needing the historical positional input ordering.

### J3-INV-10: source compatibility belongs to the stable snapshot

A Journal 3 source snapshot exposes, from one immutable committed source state:

```text
databaseVersion   = exact global/version
graphSchemeString = exact persisted global/graph_scheme
localWriter
frontier
journal records through frontier
```

Ordinary synchronization/reset may interpret/import source history only after comparing the snapshot's exact `databaseVersion` and `graphSchemeString` with the receiver's active metadata.

The compatibility decision must use metadata from the held snapshot itself. A separate mutable metadata read before `openSnapshot()` is insufficient because the source could migrate/cut over between the check and journal reads.

This requirement is transport-neutral: it constrains the semantic snapshot cut, not how Git or another carrier provides it.

## Authoritative history versus derived acceleration

Authoritative history consists of writer records and every payload/timestamp/causal fact needed by replay.

Derived state may include:

- legacy graph sublevels;
- current-head/value indexes;
- per-node history indexes;
- reverse structural-edge indexes;
- cached frontier/high-water summaries;
- synchronization scratch state;
- replay checkpoints.

Correctness must not depend on semantic information existing only in a derived accelerator.

A checkpoint may say:

```text
Checkpoint {
    frontier,
    derivedProjection
}
```

and permit loading the projection then replaying the suffix. Deleting that checkpoint is harmless to correctness. Deleting the authoritative historical records it summarizes is not Journal 3 checkpointing.

A database migration may rewrite/discard/rebuild checkpoint representation rather than versioning checkpoints independently.

## Semantic event model

Core replay history uses:

```text
ValueEvent
DeleteEvent
ValidateEvent
InvalidateEvent
```

plus writer-state records for local allocator reconstruction.

The semantic meanings are:

- `ValueEvent` — one exact historical value occurrence including payload/timestamps/identifier;
- `DeleteEvent` — semantic absence authority for one NodeKey;
- `ValidateEvent` — proof that one exact value occurrence was validated against explicitly named input occurrences;
- `InvalidateEvent` — persisted recomputation/staleness obligation with node/value scope.

High-level operation grouping may be added as non-authoritative history metadata, but replay is driven by the low-level records. Replaying an old pull/migration/reset/sync never means rerunning that old operation.

## Value identity

A new semantic value occurrence creates a new `ValueEvent` and therefore a new `ValueId`.

Equal payload bytes do not imply equal occurrence identity.

A computation which legitimately preserves the current semantic value (`Unchanged` or cache revalidation) preserves the existing ValueId and records a new validation when persisted graph state changes from stale to fresh.

## NodeIdentifier uniqueness

Journal 3 relies on the existing identifier allocator contract:

```text
NodeIdentifier ~= (DatabaseFingerprint, strictly increasing local index)
```

The fingerprint is treated as sufficiently collision-resistant by explicit repository intent. Within one continuing fingerprint namespace, `last_node_index` is a monotone retirement watermark and local allocation indices are never reused.

That is the basis for treating NodeIdentifiers as globally and forever unique. Replay still rejects observable incompatible current reuse, but does not introduce a second historical uniqueness protocol.

## Conflict authority

Journal semantic authority extends exact happened-before.

A semantic event causally after another must compare later in the total authority order.

Concurrent value occurrences normally prefer later legacy `modifiedAt` through the physical seed of the HLC. Causal monotonicity may raise that seed. Remaining ties use durable writer identity, and writer-local sequence is compared only after writer identity is equal.

The authority order is deterministic conflict precedence, not a promise of true real-time ordering under arbitrary clock skew.

## Synchronization model

Synchronization opens one stable source snapshot, verifies exact source/receiver version and graph-scheme compatibility from that snapshot, then transfers the current-format suffixes missing from that same snapshot and unions them with receiver history.

Because history itself is transferred:

- there is no `possibleMaybeChanges()` summary protocol;
- there are no compacted changed-node markers;
- there is no semantic `AdoptEvent` merely for receipt;
- "full" synchronization is the same algorithm from frontier zero.

Raw history union may require explicit receiver-authored normalization to preserve existing IncrementalGraph semantics, especially:

- dependency-closure deletion when a selected cached node has a missing input; and
- persistent value-scoped invalidation for **any selected current occurrence** whose own selected certificate exactly matches the current input ValueIds but which is stale because a direct input is stale.

The latter rule is not limited to receiver-preexisting ValueIds. If synchronization selects a remote occurrence and merged receiver-side input freshness makes that occurrence stale solely through recursive input freshness, synchronization persists that stale transition on the selected remote ValueId too.

Those normalization records are ordinary semantic history after commit, not transport acknowledgements.

Ordinary synchronization never converts records across database versions. Peers migrate first.

## Synchronization convergence model

At the retained imported-history level, compatible same-version prefix union is idempotent, commutative, and associative.

Normalization is different: synchronization may itself author real `DeleteEvent(reason="sync")` or value-scoped `InvalidateEvent(reason="sync")` records because a real receiver graph transition occurred at that synchronization boundary.

Therefore Journal 3 guarantees convergence of each actual fair execution, not counterfactual confluence across executions which really authored different normalization events.

Once ordinary graph changes, reset, migration, and other non-normalization graph-changing operations stop, synchronization creates no new positive value/validation history. Only finitely many structural-deletion and exact-ValueId stale normalization consequences can arise from the finite already-authored positive history and finite schema DAG. Fair synchronization eventually disseminates that finite closure, after which all participating replicas have observably equivalent projections and further synchronization is a semantic no-op.

The precise law/proof obligation is specified in `incremental-graph-journal-sync.md` and `incremental-graph-journal-theorems.md`.

## Reset model

Reset retains history.

It opens one held compatible source snapshot, with compatibility metadata and source history/target all belonging to the same stable source state. It then appends a receiver-authored causally later baseline whose projection matches the requested source graph semantics.

Old receiver events remain replay/debug history. There is no new journal incarnation and no cursor reset because immutable frontiers remain true statements about retained history.

Same-writer restoration which merely catches up an exact missing local suffix does not require a reset baseline.

## Migration model

Initial pre-Journal-3 bootstrap constructs a replay baseline directly in the target current database format from the supported legacy graph.

Later Journal-3-aware migration first rewrites every retained journal record into the target version's canonical representation while preserving old `JournalRecordId`s and historical meaning. It then appends a complete current-state migration baseline for any semantic graph/schema change.

Future replay uses only the one target current representation and the recorded migration result rather than rerunning historical migration callbacks or historical record-format interpreters.

The format rewrite must be deterministic so replicas which independently migrate shared history later agree exactly on overlapping same-ID target records.

Cross-version ordinary synchronization/reset remains disallowed until both sides have a compatible current interpretation.

## History retention

Journal 3 has no destructive compaction operation.

Retained history may grow with historical activity and payload volume.

Future compression, blob deduplication, archival, indexes, and checkpoints are permitted only when the logical historical identities and replay meaning remain intact.

A whole-database migration may replace an old physical encoding with the target current encoding of the same retained history; that is not destructive semantic compaction.

## Transport independence

Journal semantics do not depend on Git, a SQL database, a hosted service, filesystem snapshots, or another transport/storage product.

Journal 3 requires only transport-neutral properties such as a stable source snapshot containing exact current compatibility metadata plus ordered current-format writer-prefix reads.

Concrete remote/backend publication protocols and changes to existing transport behavior are intentionally outside the current scope.

## Current-version replay boundary

Core current-state replay operates under one compatible current `global/version` and graph schema.

The complete active journal is already encoded in that version's one canonical format. Future record-format evolution is handled by whole-database migration which rewrites all retained records before cutover, not by permanent per-record version fields or decoder/upcaster chains.

Journal-aware migration records complete target baselines so current replay never needs to rerun old application migrations.
