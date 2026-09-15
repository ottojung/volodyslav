# IncrementalGraph Journal 3

## Status and scope

Journal 3 is the append-only replay log for IncrementalGraph state.

The journal is the semantic source of truth. Existing IncrementalGraph persistence remains the efficient materialized representation used by the runtime, but its semantic contents are derived from retained Journal history rather than carrying independent synchronization authority.

This specification defines the journal itself and its integration with IncrementalGraph. It intentionally does not define a concrete remote/backend product protocol and does not redefine how an existing transport such as Git discovers or carries a stable journal snapshot.

The specification is split by responsibility across types/well-formedness, replay, emission, locking, API, synchronization, reset, migration, laws, examples, testing, storage, and lifecycle documents.

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

Journal records carry no per-record format version. A format-changing migration deterministically rewrites retained records into the target canonical representation before cutover while preserving each `JournalRecordId` and historical semantic meaning.

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

Within one database format, once `(author,sequence)` is durably published, its historical semantic meaning is immutable and not destructively compacted away.

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

Supported operations expose neither new journal + old graph nor old journal + new graph.

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

A `ValueId` is the `JournalRecordId` of one immutable semantic value occurrence.

Equal payload bytes do not make two occurrences identical.

`Unchanged`/cache revalidation preserve current ValueId and append proof history when needed.

Migration/reset likewise preserve selected ValueId whenever the semantic occurrence itself is preserved.

A semantic-preserving `override()` is explicitly occurrence-preserving: target-version representation may change through whole-history format rewrite while the ValueId and semantic occurrence remain the same.

## Validation and invalidation

Node-scoped invalidation is cleared only by causal observation in a validation.

Value-scoped invalidation applies only to one exact selected occurrence.

Among eligible validations for the selected occurrence, replay chooses one certificate maximizing:

```text
1. basisMatchCount
2. coversValueInvalidations   (true > false)
3. authority
```

## Synchronization model

Ordinary synchronization:

1. opens one stable compatible source `JournalSnapshot`;
2. transfers missing immutable writer suffixes;
3. validates overlap/contiguity/context/reference rules;
4. authors only required receiver semantic normalization;
5. replays and atomically publishes Journal + projection.

An already-established receiver at frontier zero uses the same algorithm. A completely absent installation instead uses receiver-less restoration/fresh-creation lifecycle.

Synchronization copies foreign records unchanged and creates no receipt/adoption event merely for transport.

Raw union may require sync DeleteEvents for dependency closure and value-scoped sync invalidation for any selected occurrence stale solely because a direct input is stale, including newly selected remote occurrences.

Normalization records are real semantic history.

## Synchronization convergence

Compatible raw retained-history union is idempotent/commutative/associative.

Normalization may author real semantic events, so convergence is per actual fair execution rather than counterfactual confluence across executions which authored different histories.

After non-normalization graph changes stop, only finitely many negative normalization consequences are required. Fair dissemination reaches a fixed point where replicas have equivalent projections and repeated sync is a no-op.

## Absent installation restoration

A completely absent installation must query its configured recovery source before generating a new fingerprint.

If synchronized state exists, receiver-less restore adopts the held snapshot's `localWriter` and reconstructs continuing writer history/allocator/projection. Query/read failure does not silently fall back to fresh identity.

## Canonical initial bootstrap

Legacy replicas expected to synchronize after Journal introduction share one canonical semantic bootstrap basis.

The configured transport-neutral cohort bootstrap source yields one of: existing canonical snapshot, definite absence suitable for first creation, or indeterminate/error. Indeterminate/error fails rather than authorizing a competing canonical history.

A joining legacy installation may differ from the canonical projection. It retains canonical records verbatim and appends only a local `reason="bootstrap"` delta needed to reproduce its supported legacy graph. Unaffected equal occurrences retain canonical ValueIds; local differences survive under the joining writer.

No other host must reconcile, acknowledge, or return merely for this host to finish bootstrap.

## Migration model

Format migration rewrites retained representation deterministically while preserving historical identities and semantic meaning.

Semantic migration preserves existing selected ValueIds for occurrence-preserving decisions including `keep`, `override`, `invalidate`, schema/proof/freshness-only changes, and representation-only changes.

`override()` may change target-version payload representation but does not create a new occurrence.

New ValueEvents are created only for actual semantic create/replace occurrence changes.

Journal-aware migrations do not require one canonical migration participant. Independently created replacement occurrences may later conflict; dependents naming a losing replacement may become stale/recompute. This is accepted.

## Reset model

Reset retains history and targets one compatible source projection relative to observed history.

It preserves a selected current ValueId when the receiver/source union already has the same requested semantic occurrence, creates a new ValueEvent only when the occurrence must change, and uses proof/freshness records for remaining differences.

Repeated already-satisfied reset may be a no-op.

## History retention and scope boundary

Journal 3 has no destructive compaction requirement. Retained history may grow with activity/payload volume.

The semantic design does not depend on Git, SQL, hosted services, filesystem snapshots, or another transport product. Concrete backend/publication protocol changes remain outside this specification.