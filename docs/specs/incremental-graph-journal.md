# IncrementalGraph Journal 3

## Status and scope

**Status:** this document specifies the Journal 3 target design. Journal 3 is not yet implemented in the current backend. Until implementation lands, existing non-Journal component specifications continue to describe shipped/pre-Journal behavior unless they explicitly identify themselves as target design. Journal-specific changes in this PR are normative for the future Journal 3 implementation, not claims about current runtime behavior.

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

Ordinary sync:

1. opens one stable compatible `JournalSnapshot`;
2. imports missing **foreign-writer** suffixes unchanged;
3. relies on the supported-prefix identity theorem for historical overlap and validates newly admitted/affected records, their causal/reference closure, and affected projection preconditions;
4. authors only required receiver normalization;
5. replays and atomically cuts over.

The own-writer-ahead boundary is owned by `incremental-graph-journal-lifecycle.md` §5 and the synchronization behavior by `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state.

Sync normalization may author only:

- DeleteEvents required for dependency closure;
- `value(V)` invalidations required to persist selected-occurrence staleness caused solely by stale inputs.

No computor runs during sync.

## Absent-installation restoration

When the complete local database is gone, the installation is `Absent`. Continuation safety is defined in `incremental-graph-journal-lifecycle.md` §4.1.

`InstallationRecoverySource` packages that lifecycle guarantee as a `ContinuationSafeSnapshot`; how a backend establishes it is transport-specific. This mechanism applies only to complete local absence, not to repair of an existing truncated or rolled-back database. Transport locators such as hostnames or branch names remain outside persisted IncrementalGraph state and outside the recovery semantic interface.

## Canonical pre-Journal bootstrap

Bootstrap journals the already-persisted supported legacy graph as semantic identity. It does not run an ordinary semantic migration before Journal identity exists.

One immutable `CanonicalBootstrapSnapshot` captures exactly the original creator bootstrap frontier/version/schema. Later current Journal history is not part of that artifact.

### Join value identity

- exact canonical-equal occurrence -> reuse canonical ValueId;
- local-only/different occurrence -> historical joining-writer bootstrap ValueEvent;
- divergent legacy values remain concurrent unless genuine legacy causality says otherwise;
- conflict authority is seeded by persisted legacy `modifiedAt`, not upgrade time;
- legacy cache absence is not deletion evidence.

### Join proof and freshness

For exact shared occurrence V, bootstrap uses the canonical/joining validity intersection only as the **maximum admissible edge set**, and canonical OR joining stale state as direct stale-marker evidence. Final validity/freshness remain replay-derived and occurrence-sensitive.

Canonical certificate remains the positive basis. `proof(V,D)` barriers remove canonical edges absent on the joining side; joining-only proof never strengthens or retargets the shared occurrence. If a different joining input occurrence wins selection, the retained canonical basis may mismatch it and make V hard stale even though both legacy graphs contained that semantic edge.

After direct roots, bootstrap persists recursive-only stale dependents with `value(V)` markers when own effective proof is complete.

Creator-resume installs exactly the frozen artifact when the still-pre-Journal creator's persisted graph still matches it; mismatch is `JournalBootstrapForkError`.

## Journal-aware migration

Journal-aware migration has two layers:

1. total deterministic whole-history format rewrite;
2. semantic target repair.

Representation-only change uses the canonical codec plus `keep`.

Semantic migration:

- `keep` preserves ValueId;
- `invalidate(K)` preserves cached occurrence but authors true node-scoped invalidation;
- proof/freshness/schema-only changes preserve ValueId;
- maintenance proof weakening for preserved V uses `proof(V,D)` for every non-target edge in `eligibleEffectiveProofUnion(K)`;
- target persistent stale state uses `value(V)` when own effective proof is complete;
- `create`/true replacement authors a new ValueEvent.

Independent genuine replacements may create different ValueIds on different replicas. Later normal conflict selection may stale dependents naming a losing replacement; this accepted trade-off avoids mandatory canonical migration coordination.

## Reset

Reset retains observed receiver/source history and establishes the requested source projection relative to that observed history.

Reset's own-writer-ahead behavior is defined by `incremental-graph-journal-reset.md` §Preconditions and the shared lifecycle boundary in `incremental-graph-journal-lifecycle.md` §5.

Otherwise reset preserves an already-matching occurrence, creates/replaces only when semantic occurrence state differs, uses `proof(V,D)` for every `D in eligibleEffectiveProofUnion(K) - TargetValid(K)`, persists target stale flags with `value(V)`, and authors DeleteEvent for target absence when necessary.

Reset repair is intentionally causally later than all history it observed. That rule is not reused for pre-Journal bootstrap conflict conversion.

## History retention and scope

Journal 3 requires no destructive replay-history compaction. Derived indexes/checkpoints may be rebuilt or replaced, but retained history remains authority.

Transport-specific storage/publication protocol and future synchronization-performance optimization remain separate concerns.
