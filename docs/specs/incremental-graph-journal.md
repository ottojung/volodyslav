# IncrementalGraph Journal 3

## Status and scope

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

For eligible certificates replay maximizes:

```text
1. effectiveBasisMatchCount
2. coversValueInvalidations
3. authority
```

`effectiveBasisMatchCount` ignores proof entries suppressed by uncovered `proof(V,D)` barriers.

Positive proof comes from one selected certificate. Multiple proof-edge barriers may independently subtract edges from it.

## Hard stale, soft stale, and deletion

Journal 3 has enough provenance to avoid the old input-arity keep/delete heuristic.

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
3. validates immutable overlap, causal closure, references, and projection preconditions;
4. authors only required receiver normalization;
5. replays and atomically cuts over.

If an ordinary peer exposes a longer prefix of the receiver's **own writer**, sync does not use that peer as continuation authority. It stops with `JournalWriterBehindError`; the lifecycle must perform continuation-safe same-writer recovery first.

Sync normalization may author only:

- DeleteEvents required for dependency closure;
- `value(V)` invalidations required to persist selected-occurrence staleness caused solely by stale inputs.

No computor runs during sync.

## Safe writer restoration

A generic peer snapshot is insufficient to resume a writer after local history loss.

For writer A at recovered head q, `InstallationRecoverySource` must establish the `database-lifecycle.md` §4.1 continuation-safe guarantee:

> after recovery, no previously authored A record with sequence greater than q can later enter supported retained history for writer A.

This is about future admissible history, not every record once committed to a lost local disk. If continuation safety is indeterminate, writer continuation fails rather than guessing a sequence. The same recovery source governs absent-installation restore and recovery of a behind existing writer.

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

For exact shared occurrence V:

```text
joinedValid = canonicalValid intersect joiningValid
joinedStale = canonicalStale OR joiningStale
```

Canonical certificate remains the positive basis. `proof(V,D)` barriers remove canonical edges absent on the joining side; joining-only proof never strengthens the shared occurrence merely because that host upgrades later.

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
- each removed proof edge for preserved V uses `proof(V,D)`;
- target persistent stale state uses `value(V)` when own effective proof is complete;
- `create`/true replacement authors a new ValueEvent.

Independent genuine replacements may create different ValueIds on different replicas. Later normal conflict selection may stale dependents naming a losing replacement; this accepted trade-off avoids mandatory canonical migration coordination.

## Reset

Reset retains observed receiver/source history and establishes the requested source projection relative to that observed history.

If the held reset source is ahead for the receiver's own local writer, reset fails `JournalWriterBehindError` before source import or reset authoring; lifecycle writer recovery must complete first.

Otherwise reset preserves an already-matching occurrence, creates/replaces only when semantic occurrence state differs, uses `proof(V,D)` per removed incoming edge, persists target stale flags with `value(V)`, and authors DeleteEvent for target absence when necessary.

Reset repair is intentionally causally later than all history it observed. That rule is not reused for pre-Journal bootstrap conflict conversion.

## History retention and scope

Journal 3 requires no destructive replay-history compaction. Derived indexes/checkpoints may be rebuilt or replaced, but retained history remains authority.

Transport-specific storage/publication protocol and future synchronization-performance optimization remain separate concerns.
