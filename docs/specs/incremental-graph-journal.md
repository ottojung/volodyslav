# IncrementalGraph Journal 3

## Status and scope

Journal 3 is the append-only replay log for IncrementalGraph state.

The journal is the semantic source of truth. Existing IncrementalGraph persistence remains the efficient materialized representation used by the runtime, but its semantic contents are derived from retained Journal history rather than carrying independent synchronization authority.

This specification defines the journal itself and its integration with IncrementalGraph. It intentionally does **not** define a concrete remote/backend product protocol and does not redefine how an existing transport such as Git discovers or carries a stable journal snapshot.

The specification is split by responsibility:

- `incremental-graph-journal-types.md` — identities, event shapes, causally closed contexts, authority;
- `incremental-graph-journal-well-formedness.md` — cross-record/context/reference validity;
- `incremental-graph-journal-replay.md` — deterministic projection;
- `incremental-graph-journal-emission.md` — ordinary graph transition emission;
- `incremental-graph-journal-locking.md` — atomic publication integration;
- `incremental-graph-journal-api.md` — software-facing boundaries and stable snapshots;
- `incremental-graph-journal-sync.md` — suffix replication and normalization;
- `incremental-graph-journal-reset.md` — controlled minimal rebaseline;
- `incremental-graph-journal-migrations.md` — canonical initial bootstrap and later migration;
- `incremental-graph-journal-theorems.md` — correctness laws;
- `incremental-graph-journal-examples.md` — worked traces;
- `incremental-graph-journal-testing.md` — required verification strategy.

Checkpoints/indexes may be added as derived accelerators. They never replace authoritative retained history.

## Fundamental model

A writable database has one durable writer identity:

```text
JournalAuthor = DatabaseFingerprint
```

Each writer owns one append-only stream:

```text
A:1, A:2, A:3, ...
B:1, B:2, B:3, ...
```

A local replica may retain prefixes of many writers. Foreign records retain their original writer identity when copied/relayed.

Conceptually:

```text
JournalReplica = Map<JournalAuthor, contiguous prefix>
JournalFrontier = Map<JournalAuthor, JournalSequence>
```

Missing frontier coordinates mean zero.

## Journal-first state

For one compatible current database/schema interpretation:

```text
project(J) = persisted IncrementalGraph state determined by replay of J
```

The central law is:

```text
currentGraph == project(retainedJournal)
```

Different histories may project to the same current graph. The required direction is replay completeness: the journal contains every semantic fact needed to reconstruct the graph, while graph bytes contribute no independent semantic authority.

## One current persisted format

The replica's existing `global/version` selects the persisted representation of the entire active replica, including Journal records.

Journal records carry no per-record format version. A format-changing migration deterministically rewrites retained records into the target canonical representation before cutover while preserving old `JournalRecordId`s and historical meaning.

Ordinary replay/synchronization never mixes or converts record formats.

## Core invariants

### J3-INV-1: replay completeness

For every supported committed database:

```text
semanticGraph(persistedGraph)
    == semanticGraph(project(retainedJournal))
```

Replay determines current presence, selected ValueIds, payloads, identifiers, timestamps, freshness, validity edges, and local allocation watermark.

### J3-INV-2: no independent graph authority

A persisted graph/Journal mismatch is derived-state damage or unsupported state. Repair rebuilds graph state from valid Journal history; it does not prefer mutable graph bytes over history.

### J3-INV-3: immutable journal identity

Once `(author,sequence)` is durably published, its historical meaning is immutable and not destructively compacted away.

Database-format migration may deterministically rewrite representation while preserving ID/meaning.

### J3-INV-4: one continuing stream per writer

Only writer A creates new A records. Foreign replicas retain/relay them.

A shorter exact local prefix may recover a longer exact copy of its own stream. Overlap disagreement is a fork.

### J3-INV-5: causal contexts are closed cuts

For semantic event F=(W,q):

```text
F.context[W] == q - 1
```

and every semantic event included by F's context has all of its own context included componentwise in F's context.

Therefore `happenedBefore` is transitive and represents genuine causal ancestry rather than one-hop observation.

### J3-INV-6: authority extends causality

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

Concurrent events receive deterministic conflict precedence without being turned into causal history.

### J3-INV-7: atomic journal/projection publication

Supported operations expose neither:

```text
new journal + old graph
```

nor:

```text
old journal + new graph
```

Ordinary operations use atomic publication; maintenance operations may build inactive targets and cut over.

### J3-INV-8: deterministic replay performs no historical external work

Replay never calls computors, reruns migrations/resets/sync operations, consults wall time/randomness/network services, or asks mutable graph state to supply missing semantic facts.

### J3-INV-9: validation history is self-describing

A validation basis stores explicit:

```text
{ input: NodeKey, value: ValueId | "unknown" }
```

entries in canonical NodeKeyString order.

Known ValueIds are causal predecessors of the validation. `"unknown"` is restricted to controlled baselines where exact pre-Journal proof provenance is unavailable.

## Value identity

A `ValueId` is the `JournalRecordId` of one immutable `ValueEvent` occurrence.

Equal payload bytes do not make two occurrences identical.

`Unchanged`/cache revalidation preserve the current ValueId and append proof history when needed.

Version migration and reset likewise preserve a selected ValueId whenever the semantic value occurrence itself is preserved; proof/freshness change alone is not a value replacement.

## Validation and invalidation

Node-scoped invalidation is cleared only by causal observation in a validation.

Value-scoped invalidation applies only to one exact selected occurrence.

Among eligible validations for the selected current occurrence, replay chooses one certificate maximizing:

```text
1. basisMatchCount
2. coversValueInvalidations   (true > false)
3. authority
```

This preserves the strongest sound current proof and prevents a concurrent greater-clock validation from defeating an equally matching certificate which causally covered a value invalidation.

## Synchronization model

Ordinary synchronization:

1. opens one stable compatible source `JournalSnapshot`;
2. transfers missing immutable writer suffixes;
3. validates overlap/contiguity/context/reference rules;
4. authors only required receiver semantic normalization;
5. replays and atomically publishes Journal + projection.

For an already-established receiver, full synchronization is this same operation starting from frontier zero. A completely absent installation first goes through receiver-less restoration or fresh creation so it has a local writer identity.

Synchronization copies foreign records unchanged and creates no receipt/adoption event merely for transport.

Raw union may require:

- sync DeleteEvents for dependency-closure removal;
- value-scoped sync invalidation for any selected occurrence stale solely because a direct input is stale, including newly selected remote occurrences.

Normalization records are real semantic history.

## Synchronization convergence

Compatible raw retained-history union is idempotent/commutative/associative.

Normalization may author real semantic events, so the convergence claim is per actual fair execution rather than counterfactual confluence across executions which authored different histories.

After non-normalization graph changes stop, only finitely many negative normalization consequences are required. Fair dissemination reaches a fixed point where replicas have equivalent projections and repeated sync is a no-op.

## Absent installation restoration

A completely absent installation must query its configured recovery source **before** generating a new fingerprint.

If its synchronized state exists, receiver-less restore adopts the held snapshot's `localWriter` and reconstructs its continuing writer history/allocator/projection.

Failure to query/read known synchronized state is fatal; it does not silently fall back to a fresh identity.

## Canonical initial bootstrap

Legacy replicas which are expected to synchronize after Journal introduction share one canonical semantic bootstrap history.

Equivalent legacy hosts do not independently mint duplicate bootstrap ValueIds. They retain the canonical semantic history while preserving their own local writer fingerprint and allocator state.

Legacy differences intended to survive must be reconciled before crossing the Journal boundary or handled through an explicit rebaseline/import decision.

## Migration model

Format migration rewrites retained representation deterministically while preserving historical identities.

Semantic migration preserves existing selected ValueIds when cached occurrence fields are kept. Schema/proof/freshness changes may append new Validate/Invalidate events targeting the preserved ValueId.

New ValueEvents are created only for actual create/replace/transform occurrence changes.

When a migration truly creates/replaces occurrences, a synchronization cohort retains one canonical semantic migration result rather than independently minting equivalent new ValueIds.

## Reset model

Reset retains history and targets one compatible source projection relative to observed history.

It preserves a selected current ValueId when the receiver/source union already has the same requested immutable value state, creates a new ValueEvent only when the value occurrence must change, and uses proof/freshness records for the remaining target differences.

Repeated already-satisfied reset may be a no-op.

## History retention and scope boundary

Journal 3 has no destructive compaction requirement. Retained history may grow with activity/payload volume.

The semantic design does not depend on Git, SQL, hosted services, filesystem snapshots, or another transport product. Concrete backend/publication protocol changes remain outside this specification.
