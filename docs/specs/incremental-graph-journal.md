# IncrementalGraph Journal 3

## Status and scope

**Status:** this document specifies the Journal 3 target design. Journal 3 is not yet implemented in the current backend. Until implementation lands, existing non-Journal component specifications continue to describe shipped/pre-Journal behavior unless they explicitly identify themselves as target design. The Journal-owned specifications are normative for the Journal 3 implementation and make no claims about current runtime behavior.

Journal 3 is the append-only replay history for IncrementalGraph state.

```text
currentGraph == project(retainedJournal)
```

The Journal is semantic authority. Existing IncrementalGraph sublevels remain the efficient materialized runtime representation but carry no independent synchronization authority.

This specification defines Journal semantics and local lifecycle integration. It intentionally does not define a hosted backend, SQL/RPC protocol, or replacement Git transport.

## Writer streams

```text
JournalAuthor = DatabaseFingerprint
```

Each writer owns one contiguous immutable stream:

```text
A:1, A:2, ...
B:1, B:2, ...
```

A replica may retain prefixes from many writers. Foreign records keep their original identity.

## One current persisted format

`global/version` selects one representation for the complete active database, including Journal records.

Journal records have no per-record version tag. Format-changing migration rewrites the complete retained source-version history into one canonical target representation before cutover while preserving record IDs and historical meaning.

That transform is total over retained history, including records for node families absent from the target schema. If some retained record has no deterministic target representation, migration fails `JournalVersionCompatibilityError` before cutover.

## Core invariants

### Replay completeness

For every supported committed database:

```text
semanticGraph(persistedGraph)
    == semanticGraph(project(retainedJournal))
```

Replay determines presence, selected ValueIds, payloads, identifiers, timestamps, freshness, validity edges, and local allocation watermark.

### Immutable identity

Within one database format, `(author,sequence)` has one immutable historical meaning. Same-ID disagreement is a fork, not a graph conflict.

### Causal closure

For semantic event `F=(W,q)`:

```text
F.context[W] == q - 1
```

and all causal observations of included events are themselves included. Thus `happenedBefore` is transitive.

Authority is a deterministic total order extending happened-before.

### Atomic graph/Journal publication

Supported state exposes neither new Journal + old graph nor old Journal + new graph.

### Lifecycle-owned persistence

While a local database exists, its persistent state changes only through supported Volodyslav lifecycle transitions. Complete local database disappearance is supported and produces the lifecycle `Absent` state. Partial rollback, truncation, mixed restoration, or external mutation of an existing database is outside the supported lifecycle model, per `$id-6158827469032147`.

### Replay performs no historical external work

Replay never invokes computors, reruns lifecycle operations, asks wall clock/randomness/network for semantic facts, or repairs meaning from mutable graph bytes.

## Value identity

A `ValueId` is the JournalRecordId of one semantic value occurrence. Equal payload bytes do not imply equal ValueIds.

`Unchanged` and cache revalidation preserve the current ValueId and add proof history as needed.

Reset/migration likewise preserve ValueId whenever the semantic occurrence survives. Representation-only Journal migration preserves the occurrence through the canonical whole-history codec; selected preserved state uses `keep`.

## Validation and invalidation

Validation bases explicitly name each input NodeKey and the ValueId used for that input.

Journal has three distinct invalidation scopes:

```text
node
value(V)
proof(V,D)
```

- `node` — genuine direct/explicit node invalidation;
- `value(V)` — persistent stale freshness for exact occurrence V;
- `proof(V,D)` — maintenance-only negative evidence retiring incoming proof edge `D -> K` for exact occurrence V until causally re-proved.

Proof barriers are edge-specific, not whole-certificate barriers.

Certificate selection and effective-basis calculation are owned by `incremental-graph-journal-replay.md` §Certificate selection and §Effective basis match.

Conceptually, positive proof comes from one replay-selected certificate while proof-edge barriers may independently subtract edges from it.

## Hard stale, soft stale, and deletion

For current cached K:

- if a required direct input is absent -> K is structurally non-materializable and synchronization authors DeleteEvent over the dependent closure;
- if all required inputs remain present but some certificate input ValueId no longer matches -> keep K as legitimate `oldValue`; K is hard stale / partially valid according to effective proof;
- if K's effective certificate matches every current input occurrence but some input is stale -> keep K and its proof; K is recursively/soft stale and receives persistent `value(Kcurrent)` stale history when the graph semantics store that transition;
- if effective proof fully matches, inputs are fresh, and no own stale invalidation remains -> K is fresh.

The number of inputs is irrelevant.

## Ordinary synchronization

Ordinary synchronization semantics—including snapshot compatibility, immutable foreign-history import, receiver normalization, convergence, and operation-specific own-writer-ahead behavior—are owned by `incremental-graph-journal-sync.md`; the shared established-writer rollback classification is owned by `incremental-graph-journal-lifecycle.md` §5.

## Absent-installation restoration

When the complete local database is gone, the installation is `Absent`. Continuation safety is defined in `incremental-graph-journal-lifecycle.md` §4.1.

`InstallationRecoverySource` packages that lifecycle guarantee as a `ContinuationSafeSnapshot`; how a backend establishes it is transport-specific. This mechanism applies only to complete local absence, not to repair of an existing truncated or rolled-back database. Transport locators such as hostnames or branch names remain outside persisted IncrementalGraph state and outside the recovery semantic interface.

## Canonical pre-Journal bootstrap

Canonical pre-Journal bootstrap—including creator creation/resume, joining, exact-shared identity/proof/freshness, and first-creator arbitration—is owned by `incremental-graph-journal-migrations.md` Part I (§§1–8), with lifecycle gating owned by `incremental-graph-journal-lifecycle.md`.

## Journal-aware migration

Journal-aware migration—including whole-history format rewriting, the semantic decision vocabulary, target construction, proof/freshness repair, and the canonical version chain—is owned by `incremental-graph-journal-migrations.md` Part II (§§9–22).

## Reset

Reset semantics—including raw-union repair, occurrence preservation/replacement, proof weakening, target freshness, and operation-specific own-writer-ahead behavior—are owned by `incremental-graph-journal-reset.md`, with the shared rollback classification owned by `incremental-graph-journal-lifecycle.md` §5.

## History retention and scope

Journal 3 requires no destructive replay-history compaction. Derived indexes/checkpoints may be rebuilt or replaced, but retained history remains authority.

Transport-specific storage/publication protocol and future synchronization-performance optimization remain separate concerns.
