# IncrementalGraph Journal 3

## Status and scope

This document defines the core Journal 3 model for one fixed compatible IncrementalGraph database version and graph schema.

Journal 3 is an append-only replay log. It is the semantic source of truth for persisted IncrementalGraph state. The existing IncrementalGraph sublevels remain the efficient materialized representation used by the runtime, but their semantic contents are derived from Journal 3 rather than carrying independent synchronization authority.

The detailed record types and ordering rules are defined by `incremental-graph-journal-types.md`. The deterministic projection is defined by `incremental-graph-journal-replay.md`. Replication of journal history is defined by `incremental-graph-journal-sync.md`.

Migration between database/schema versions, controlled reset, replay checkpoints, and the concrete remote storage protocol are separate specifications. They must preserve the core laws in this document.

## Fundamental model

A Journal 3 database has one durable writer identity:

```text
JournalAuthor = DatabaseFingerprint
```

Each author owns one immutable append-only writer stream:

```text
A:1, A:2, A:3, ...
B:1, B:2, B:3, ...
C:1, C:2, C:3, ...
```

A local Journal 3 replica may retain prefixes of many writer streams. A writer may append new records only to its own stream. Synchronization copies foreign records verbatim; it does not rename, re-author, or summarize them into receiver-local history.

The complete retained journal is therefore a set of immutable per-writer prefixes. Its frontier is:

```text
JournalFrontier = Map<JournalAuthor, JournalSequence>
```

where a missing author coordinate means zero.

For example:

```text
{
    A: 417,
    B: 93,
    C: 51
}
```

means that the local replica contains exactly records `A:1..417`, `B:1..93`, and `C:1..51` for those writers.

A supported journal frontier is causally closed: if a retained semantic event claims to have observed another writer through coordinate `q`, then the retained journal also contains that writer through `q`.

## Journal-first state

Let `J` be a supported causally closed Journal 3 replica under one fixed compatible graph schema.

Define:

```text
project(J) = the persisted IncrementalGraph semantic state determined by replay
```

The central Journal 3 law is:

```text
currentGraph == project(retainedJournal)
```

The existing graph database is therefore a materialized view of the journal.

This is a reconstruction requirement, not a requirement that the mapping from history to current graph be mathematically injective. Different histories may legitimately project to the same current graph. The required direction is that the journal contains all semantic information necessary to determine the graph; the graph contributes no additional semantic fact which replay would need to guess.

In particular, a supported implementation must be able to discard the materialized graph representation and rebuild an observationally equivalent one from the journal under the same database version/schema interpretation.

## Core invariants

### J3-INV-1: replay completeness

For every supported committed Journal 3 database state:

```text
semanticGraph(persistedLegacySublevels)
    == semanticGraph(project(retainedJournal))
```

Replay must determine, for every materialized semantic node:

- whether it is materialized;
- its selected value occurrence and exact `ComputedValue` payload;
- its `createdAt` and `modifiedAt` timestamps;
- its freshness;
- its incoming validity relation;
- the selected physical `NodeIdentifier` carried by the winning materialization occurrence.

The legacy `identifiers_keys_map`, `values`, `timestamps`, `freshness`, and `valid` records must be the lowering of that replay result into the unchanged legacy storage representation.

Host-local allocation metadata such as `last_node_index` is replayed from journal writer-state records as defined by the types/replay specifications.

### J3-INV-2: no independent graph authority

No existing IncrementalGraph sublevel may contain synchronization or semantic authority absent from the retained journal.

A mismatch between the journal projection and persisted graph sublevels is unsupported/corrupt state. Opening code may detect and reject such a mismatch or rebuild derived projection state according to a separately specified repair/replay procedure; it must not resolve the disagreement by treating the legacy graph as an additional source of truth.

### J3-INV-3: append-only immutable history

Once a journal record has become durable under `(author, sequence)`, its identity and content never change and the record is not destructively removed by Journal 3 maintenance.

A supported writer stream is a contiguous prefix beginning at sequence 1. Reusing a durable record identity for different content is forbidden.

Derived checkpoints or indexes may be deleted and regenerated. Authoritative journal records may not.

### J3-INV-4: writer ownership

Only database `A` may append new records under author `A`.

A receiver may retain and relay immutable records from another author, but doing so does not make those records receiver-authored. If synchronization itself causes a genuinely new semantic transition which requires a new record, that record is appended under the receiver's own writer identity.

A writable database must not continue authoring beneath a later surviving prefix of its own writer stream. Discovery of later same-writer history is a recovery/fork condition, not ordinary foreign synchronization.

### J3-INV-5: causal closure

Every retained semantic event's causal context is covered by the retained journal frontier.

For event `E` and every author `A`:

```text
E.context[A] <= retainedFrontier[A]
```

A synchronization implementation may receive records out of network order, but it must not expose a committed supported journal/projection state in which retained semantic events have missing causal prerequisites.

### J3-INV-6: atomic journal/projection publication

Whenever an ordinary local operation appends journal records and changes the materialized graph projection, the appended records and the matching projection changes become durable atomically.

No supported committed state exposes the graph effect without the journal records which determine it, or the journal records without the corresponding materialized projection.

Synchronization may build an inactive target and cut over atomically. Ordinary graph transactions may use the existing graph commit boundary. The physical mechanism is implementation-specific; the observable atomicity is normative.

### J3-INV-7: deterministic replay

For one fixed compatible database version/schema and one supported causally closed journal `J`, replay is deterministic.

Two implementations replaying the same journal under the same interpretation must select the same semantic node heads, values, timestamps, freshness, and validity relation. Local filesystem paths, temporary replica-slot names, and other non-graph operational artifacts are outside this equality.

### J3-INV-8: replay has no external side effects

Replay never invokes a computor and never re-executes the historical external operation which originally produced an event.

Replay must not depend on current wall-clock time, random numbers, network services, files outside the database, or other ambient external state.

Historical nondeterministic choices are data in journal records. A `ValueEvent`, for example, contains the actual value occurrence produced historically; replay uses that recorded payload rather than calling the computor again.

## Journal records versus derived state

Journal 3 distinguishes authoritative history from disposable acceleration state.

Authoritative history includes the immutable writer streams and every payload/timestamp/causal fact required by replay.

Derived state may include:

- the current legacy IncrementalGraph sublevels;
- per-node current-head indexes;
- per-node event indexes;
- reverse structural-edge indexes;
- cached causal/high-water summaries;
- replay checkpoints/snapshots;
- synchronization progress/frontier indexes.

Derived structures may be maintained transactionally for performance, but correctness must not depend on information existing only in them.

A checkpoint is therefore conceptually:

```text
Checkpoint {
    frontier,
    derivedProjection
}
```

It may accelerate restoration by loading `derivedProjection` and replaying only records after `frontier`. Deleting the checkpoint must not destroy history. Deleting authoritative records before the checkpoint is not Journal 3 checkpointing and is outside the base design.

## Semantic records

The core semantic history consists of low-level immutable events sufficient to reconstruct graph meaning. Journal 3 initially uses these semantic event classes:

```text
ValueEvent
DeleteEvent
ValidateEvent
InvalidateEvent
```

Their exact fields are defined in `incremental-graph-journal-types.md`.

The important distinction is:

- a `ValueEvent` records one exact semantic value occurrence, including payload and timestamps;
- a `DeleteEvent` records semantic absence authority;
- a `ValidateEvent` records validation of one value occurrence against exact input value occurrences;
- an `InvalidateEvent` records a stale/recompute obligation with its scope.

High-level operation grouping may be recorded as additional historical metadata, but replay authority belongs to the low-level semantic events. Replaying a historical `pull`, migration, synchronization, or reset must never mean re-running that high-level operation.

## Value occurrence identity

A successful computation which changes the semantic value creates a new immutable value occurrence. Its `ValueId` is the journal identity of its `ValueEvent`.

The value event contains the exact payload and timestamp facts needed to reconstruct that occurrence. Copies of a `ValueId` across replicas therefore necessarily refer to the same payload and `modifiedAt`/`createdAt` carried by that occurrence.

Payload equality does not create value identity. Two independently authored equal `ComputedValue`s remain distinct occurrences unless they are literally the same retained `ValueEvent`/`ValueId`.

A computation which returns `Unchanged`, or otherwise preserves the current semantic value under the IncrementalGraph contract, preserves the existing `ValueId` and records only the validation required by that transition.

## Physical NodeIdentifier ownership

A `ValueEvent` records the `NodeIdentifier` of the materialization occurrence it creates or preserves as specified by the emission rules.

The selected present value occurrence therefore supplies the physical identifier used by the legacy projection. When synchronization selects a foreign value occurrence, the projection may use that occurrence's globally namespaced identifier because identifiers include the allocating database fingerprint.

If two retained present occurrences for different semantic nodes claim the same physical identifier, or one writer reuses an identifier incompatibly, the journal is unsupported/corrupt rather than resolved by payload equality or arbitrary reassignment.

Writer-local allocation-watermark history is retained separately so `last_node_index` can also be reconstructed without treating the current legacy value as authority.

## History retention

Journal 3 has no destructive compaction operation.

The retained history may grow without a total-size bound independent of the number or size of historical events. This is intentional: replayability and debuggability are semantic properties of the design rather than temporary implementation conveniences.

Future storage optimizations may include compression, immutable blob deduplication, archival tiers, checkpoints, indexes, or transport batching. Such optimizations must preserve the logical immutable record history and replay result.

## Transport independence

The journal model does not depend on Git, Supabase, PostgreSQL, filesystem snapshots, or another transport/storage product.

A transport may publish and fetch writer-stream prefixes, but transport identifiers do not become journal identities or conflict authority.

The long-term remote synchronization payload is the journal history itself (and optional replay accelerators), not a rendered copy of the mutable current graph.

## Convergence target

Journal replication has a simple information-level join: compatible replicas retain immutable prefixes and synchronization obtains missing suffixes. For a fixed set of immutable records, union is idempotent, commutative, and associative.

The harder Journal 3 requirement is that the graph projection of the resulting causally closed history is deterministic and respects the IncrementalGraph operational contract.

Therefore, once graph-changing operations and synchronization-authored semantic normalization (if any is required by later synchronization specifications) stop, fair dissemination of all retained journal records must bring every supported replica to the same semantic journal history and hence the same observable IncrementalGraph projection.

## Fixed-version boundary

This core specification assumes one exact compatible database version and graph schema while replaying the semantic events described here.

A Journal-3-aware migration specification must define how version/schema transitions themselves become replayable history. It must not weaken replay completeness by requiring a future restorer to execute historical application code whose output was not recorded.
