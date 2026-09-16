---
title: Database Lifecycle
---

# Volodyslav Database Lifecycle

## 1. Overview

This document specifies the supported lifecycle of Volodyslav's synchronized IncrementalGraph database under Journal 3.

The central law is:

```text
persisted materialized graph == project(retained journal)
```

The journal is semantic authority. Existing graph sublevels are a materialized projection.

The active replica has one current persisted representation selected by `global/version`. Journal records do not carry independent record versions.

This is a lifecycle specification, not a transport/backend specification. It requires stable Journal snapshots and controlled local publication, but does not prescribe Git layout, a hosted backend, HTTP/RPCs, or another transport protocol.

The normal startup operation remains:

```sh
volodyslav start
```

Raw filesystem/database manipulation is not a supported lifecycle transition.

## 2. Lifecycle states

A local installation is in one of these lifecycle states:

- **Absent** — no supported local database/writer identity is established.
- **Legacy/migratable** — a structurally valid older database exists and the running version supplies a supported migration.
- **Current** — active database version/schema match the running application and graph equals Journal replay.
- **Incompatible for an operation** — independently valid state cannot participate in the requested sync/reset/migration boundary.
- **Corrupted/unsupported** — required invariants fail or state was produced outside supported transitions.

Supported transitions include:

1. absent-state restoration of this installation's own synchronized history;
2. fresh creation when no such history exists;
3. open;
4. ordinary graph evolution;
5. pre-Journal bootstrap / Journal-aware migration;
6. synchronization;
7. controlled reset;
8. projection rebuild.

A successful startup reaches **Current** before graph-backed APIs are exposed.

## 3. Startup flow

Conceptually startup performs:

1. validate required operating context;
2. determine whether supported local database state exists;
3. if local state is absent, run the **absent-state decision** below;
4. open established local state sufficiently to read its version metadata;
5. run the migration gate when required;
6. validate/rebuild Journal-derived projection state when applicable;
7. expose the IncrementalGraph interface.

Startup never silently reinterprets malformed/incompatible existing state as a fresh database.

Routine startup of an already-current local database does not imply ordinary multi-source synchronization unless outer application policy explicitly requests it.

Maintenance transitions are exclusive with ordinary graph activity at their publication/cutover boundary.

## 4. Absent-state decision

The absent-state decision happens **before generating a new DatabaseFingerprint**.

The outer lifecycle has one configured, transport-neutral way to ask for the synchronized state belonging to **this installation**. Call that the installation recovery source.

Journal 3 does not define whether that source is found via hostname, Git, files, or another transport. It defines the required decision once such a source abstraction exists.

### 4.1 Query the installation recovery source

Startup asks whether synchronized state for this installation exists.

Three outcomes are distinct:

1. **source exists** — open/hold that source's stable database snapshot and restore it;
2. **source definitely does not exist** — fresh creation is allowed;
3. **query/read failed or result is indeterminate** — startup fails.

A failure to query or obtain known synchronized state **MUST NOT fall back** to fresh creation.

This avoids accidentally orphaning the continuing writer stream and reusing a different allocator namespace simply because the recovery source was temporarily unavailable.

### 4.2 Receiver-less restore

Restoring an absent installation is conceptually a distinct lifecycle operation:

```text
restoreAbsentFrom(snapshot) -> Current-or-Migratable local database
```

It is not `synchronizeFrom()` or `resetTo()`, because those operations require an already-established writable receiver identity.

The held source snapshot supplies the continuing installation identity:

```text
localWriter = snapshot.localWriter
```

That `DatabaseFingerprint` becomes the local allocation fingerprint exactly as in the existing first-boot restore contract.

The restore retains the source journal/history/projection needed to reconstruct that installation's state and reconstructs:

- local writer head;
- local `last_node_index`;
- authority high-water;
- materialized graph;
- derived indexes/caches.

No new semantic records are required merely to restore exact retained history.

The restored snapshot may be at an older supported database version. After local installation, startup runs the normal migration gate before exposing the graph.

### 4.3 Fresh creation only after definite absence

Only when the configured installation recovery source definitively reports that no synchronized state exists may startup create a genuinely new database.

Fresh creation:

- generates one new durable `DatabaseFingerprint`;
- starts with local writer frontier zero;
- starts with no retained foreign history;
- materializes an empty graph;
- initializes local `last_node_index` according to the ordinary allocator contract;
- records current version/schema metadata.

Thus:

```text
project(empty journal) = empty graph
```

No semantic event is required merely to represent arbitrary absent nodes.

## 5. Same-writer restoration and recovery

Absent-state restore above handles a completely missing local database.

A **behind but existing Journal installation** uses exact-prefix same-writer recovery.

Suppose current local writer A retains:

```text
A:1..p
```

and one compatible held source contains:

```text
A:1..q
q >= p
```

with exact overlap equality.

Under exclusive maintenance it may retain `A:(p+1)..q`, together with causally required foreign history, then reconstruct writer allocator/high-water/projection state before authoring anything new.

New A records start strictly after q.

If any overlapping A record differs, recovery fails as a writer fork.

Two independently live installations intentionally authoring under one fingerprint are unsupported.

A pre-Journal creator which published its canonical bootstrap artifact but crashed before local cutover is **not** this case because it has no active Journal prefix yet. That dedicated creator-resume transition is specified in §8.2.

## 6. Opening current Journal state

Opening a current Journal database establishes one coherent pair:

```text
(retained journal, materialized projection)
```

Required supported state includes:

- contiguous writer streams;
- one current record format selected by `global/version`;
- transitively closed semantic-event contexts;
- current version/schema compatible with the running interpretation;
- graph observationally equivalent to replay, or successfully rebuilt before exposure;
- local writer allocator state consistent with retained local history.

Known graph/journal disagreement is not exposed as ordinary current state.

## 7. Ordinary evolution

Ordinary graph operations append replay-complete Journal history according to `incremental-graph-journal-emission.md`.

For every successful committed semantic transition:

```text
project(journalAfter) == graphAfter
```

Journal/graph publication is atomic. Failed transactions consume no durable Journal coordinate.

A successful operation which changes no persisted semantic state need not append a semantic event merely because the API was invoked.

## 8. Migration

Migration is the controlled transition between whole-database versions/schema interpretations.

Detailed rules are normative in `incremental-graph-journal-migrations.md`.

### 8.1 Migration gate

After reading the stored database version:

- matching version -> no migration;
- supported older Journal version -> run its Journal-aware migration independently;
- unsupported version -> fail;
- supported pre-Journal state -> run the canonical-bootstrap-source decision below.

Absence of stored version is treated as fresh only under the genuine fresh-creation rules; it does not erase structured existing state whose metadata is malformed/missing.

For every pre-Journal source version which the running release supports, its migration table identifies one expected **bootstrap target version/schema**.

The running release is not required to retain legacy bootstrap support forever. If an existing canonical artifact's version/schema is not exactly the release's expected bootstrap target, startup fails with `JournalVersionCompatibilityError` before authoring history. Recovery of such an older legacy installation requires software which explicitly supports that historical bootstrap target, followed by the ordinary supported upgrade lifecycle.

### 8.2 Pre-Journal multi-host bootstrap

Replicas expected to synchronize after Journal bootstrap use one canonical semantic bootstrap history as the shared ValueId basis for occurrences equal to the canonical cut.

The lifecycle has a configured transport-neutral **cohort bootstrap source**. Its `Exists(...)` result is a frozen `CanonicalBootstrapSnapshot`, not a current database snapshot.

Before creating or joining bootstrap history, startup obtains exactly one of three outcomes:

1. **canonical artifact exists** -> validate it and choose creator-resume or ordinary join based on writer identity;
2. **source definitively does not exist** -> `createCanonicalBootstrap` is allowed;
3. **query failed or result is indeterminate** -> startup/migration fails and MUST NOT create a competing canonical history.

The cohort bootstrap source is responsible only for this lifecycle decision/artifact abstraction. Journal 3 does not prescribe how Git or another transport implements it.

A source may report definite absence only when that answer is suitable for first-creator selection; otherwise it must report indeterminate. Distinct canonical bootstrap artifacts for one cohort are unsupported and require explicit recovery rather than payload-based merge.

The creator freezes the canonical artifact at the exact frontier immediately after bootstrap and before any ordinary Journal operation. `createCanonicalBootstrap` does not report success until that artifact is durably established.

Before either resume or join, require:

```text
canonical.databaseVersion   == expectedBootstrapTargetVersion
canonical.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

Mismatch is `JournalVersionCompatibilityError`.

#### Creator resume

If:

```text
canonical.creatorWriter == local DatabaseFingerprint
and local state is still pre-Journal
```

startup resumes the interrupted canonical creation rather than joining as a second writer.

It:

1. installs exactly the artifact records through `bootstrapFrontier` as the continuing local writer stream;
2. projects that artifact with the local writer identity;
3. interprets the local legacy database into the same bootstrap-target semantic graph;
4. requires semantic equality of presence, payloads, NodeIdentifiers, timestamps, freshness, and validity;
5. on mismatch, fails with `JournalBootstrapForkError` and authors/cuts over nothing;
6. on equality, reconstructs writer head, `last_node_index`, authority high-water, projection, and derived indexes from the artifact;
7. atomically cuts over and resumes the ordinary migration gate.

This closes the crash window where the canonical artifact was published durably but the creator's local Journal cutover did not complete.

A different fingerprint MUST NOT use creator-resume.

#### Ordinary joining installation

The join uses only records through the frozen `bootstrapFrontier`.

A divergent legacy value is not made causally later merely because its host upgrades later. Instead the join:

- reuses canonical ValueId for equal occurrences;
- converts local-only/different occurrences into concurrent historical bootstrap ValueEvents seeded by their own legacy `modifiedAt`;
- uses normal Journal authority to decide conflicting occurrences;
- does not treat one legacy cache's absence as deletion evidence;
- establishes proof/freshness metadata after value occurrences are represented;
- preserves the joining host's own fingerprint and allocator watermark.

Two independent late joiners with the same occurrence that differs from the canonical cut may assign distinct bootstrap ValueIds. Later synchronization may stale dependents naming the losing one. That accepted limitation is `$id-1635227135166767`; bootstrap does not add a second identity-reconciliation protocol for non-canonical legacy state.

Therefore a local legacy difference survives only when non-conflicting or when it wins normal conflict authority. Upgrade time is not a conflict-precedence signal.

After the bootstrap-target Journal/projection pair is installed, startup continues only through migration steps the running release actually supports. Post-bootstrap cohort history enters later via ordinary synchronization once versions are compatible.

No particular remote host needs to reconcile, acknowledge, or return merely for this installation to complete bootstrap.

### 8.3 Journal-aware migration

A Journal-aware migration:

1. validates source Journal/projection under source version;
2. deterministically rewrites every retained record into target representation, preserving IDs/meaning;
3. applies one pure per-record payload rewrite to every affected retained ValueEvent regardless of whether it is currently selected;
4. computes target graph under isolated target storage;
5. preserves existing ValueIds for semantic occurrences kept by `keep`, `override`, `invalidate`, or equivalent occurrence-preserving decisions;
6. treats `override()` as an assertion that selected rewritten payload equals the canonical per-record rewrite result;
7. creates new ValueEvents only for actual new/replaced semantic occurrences;
8. uses a node-scoped **proof barrier** before a target proof removes currently-valid incoming edges, so older stronger certificates cannot re-win;
9. uses validation/invalidation records for exact target proof/freshness without replacing values unnecessarily;
10. persists migration-propagated stale flags with value-scoped invalidation whenever a target-stale occurrence's own proof is otherwise complete, even if it is already recursively stale through an input;
11. verifies target replay;
12. atomically cuts over.

A Journal-aware `override()` result that disagrees with the canonical per-record rewrite fails migration before cutover.

Journal-aware migration does not require one canonical migration participant. Independently migrated replicas may author different ValueIds for genuinely replaced occurrences. When those histories later synchronize, ordinary conflict/certificate rules may make affected dependents stale and require later recomputation/revalidation; that consequence is accepted.

Future replay does not rerun historical migration callbacks.

A whole-history representation rewrite may cost time/I/O proportional to retained Journal size; that is an accepted migration trade-off.

## 9. Synchronization

Journal synchronization is defined by `incremental-graph-journal-sync.md`.

Ordinary sync requires exact compatibility with one held source `JournalSnapshot`:

```text
snapshot.databaseVersion == receiver global/version
snapshot.graphSchemeString == receiver global/graph_scheme
```

Compatibility metadata and imported records come from the same stable source cut.

A pairwise sync:

1. enters exclusive maintenance ownership for final publication;
2. opens one stable source snapshot;
3. checks compatibility from that snapshot;
4. streams missing immutable writer suffixes;
5. validates overlap, contiguity, causal closure, and reference causality;
6. performs required receiver-authored semantic normalization;
7. replays/validates the final projection;
8. atomically publishes Journal + projection.

No computor executes during sync.

An outer multi-source operation may commit successful sources independently; failure of a later source need not roll back earlier source commits.

Transport may carry snapshots but does not determine graph conflicts.

## 10. Controlled reset

Controlled reset is specified by `incremental-graph-journal-reset.md`.

It means:

> make the receiver's projected graph equal to a chosen compatible source projection relative to all history currently observed

without deleting history.

Reset preserves an already-selected value occurrence when its immutable semantic value state already matches the target. It authors new ValueEvents only where the value occurrence must actually change.

If reset needs to remove an incoming validity edge, it first authors a node-scoped proof barrier so older stronger certificates become ineligible, then establishes the target proof. If the reset target stores a node stale while its own proof is otherwise complete, reset persists that stale flag with a value-scoped invalidation even when current recursive replay is already stale through an input.

An unseen concurrent event may later affect ordinary synchronization normally.

A completely absent installation does not use reset; it uses §4 receiver-less restoration.

Pre-Journal canonical bootstrap join is also **not reset**: bootstrap value conflicts represent pre-existing legacy facts and must not inherit reset's rule that target repairs are causally after the complete observed frontier.

## 11. Projection rebuild

A maintenance operation may rebuild graph/index state from valid retained Journal history under exclusive maintenance.

It may recreate identifiers/value/freshness/timestamp/valid sublevels, reverse indexes, cached frontier/high-water/current-head state, and other replay accelerators.

It must not rewrite authoritative Journal meaning merely to make replay succeed.

If authoritative history is invalid/forked, rebuild fails.

## 12. User/API expectations

### `pull()`

May recompute and append Journal events. Success implies graph and corresponding replay history are already committed atomically.

### `invalidate()`

Records invalidation/staleness without recomputing the target.

### inspection

Reads the materialized projection without invoking computors merely for diagnostics.

### synchronization

May change values, identifiers, freshness, validity, and materialization by importing/replaying history and authoring required normalization, but never invokes computors.

### reset

May intentionally rebaseline observable graph state while retaining old history. Success is atomic.

### migration/startup

Graph APIs are not initialized until required restore/bootstrap/migration/replay validation completes.

## 13. Trust model

Supported participants are non-adversarial but may be stale, interrupted, offline, delayed, or incompatible.

Correctness still rejects observable malformed state, writer forks, non-closed causal contexts, broken reference causality, and Journal/projection invariant failure.

Journal 3 does not require Byzantine provenance or malicious-peer containment.

## 14. Unsupported operations

Unsupported operations include:

- manually editing Journal records;
- changing one same-version record's semantic meaning while keeping its ID;
- mixed record formats in one active replica;
- destructive authoritative-history truncation followed by continued same-writer authoring;
- independently cloning one writer identity into multiple live writers;
- manually editing graph sublevels away from Journal replay;
- bypassing required version migration;
- forcing ordinary sync/reset across incompatible snapshot metadata;
- using an arbitrary current Journal snapshot in place of the frozen canonical bootstrap artifact;
- joining a canonical artifact whose target version/schema the running release does not support;
- independently creating a second canonical pre-Journal bootstrap after a canonical artifact already exists;
- making a late legacy value causally later solely because bootstrap code observed the canonical artifact;
- using creator-resume under a fingerprint other than `artifact.creatorWriter`;
- continuing creator-resume when artifact projection and local legacy target disagree;
- using replica-local `override()` output to rewrite an immutable retained Journal record differently from the canonical version codec;
- treating semantic-changing `override()` as a representation-only rewrite;
- treating a checkpoint as replacement authority for missing history.

New recovery/import behavior must be introduced as an explicit controlled transition with stated invariants.

## 15. Corruption versus incompatibility

A database may be valid independently yet incompatible with one requested operation.

Corruption/unsupported evidence includes:

- same writer/sequence with different bodies;
- committed stream holes;
- non-closed semantic-event contexts;
- mixed current record formats;
- impossible ValueId references;
- incompatible current NodeIdentifier reuse;
- creator-resume artifact/local-legacy semantic disagreement;
- graph known to disagree with replay without successful rebuild;
- local allocator state which could reuse a retired index.

Operations fail where such evidence becomes relevant. They must not silently convert corruption into a fresh database or ordinary graph conflict.
