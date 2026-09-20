---
title: Journal 3 Lifecycle (target design)
---

# Journal 3 Database Lifecycle (target design)

## 1. Overview

**Status:** this document specifies the Journal 3 target lifecycle. Journal 3 is not yet implemented in the current backend. Current startup/migration/storage behavior remains governed by the shipped component implementation and its non-Journal documentation until the Journal 3 implementation lands. This document defines the lifecycle the implementation must move to; it does not claim that current runtime classes such as `InstallationRecoverySource` or Journal-specific errors already exist.

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

Persistent IncrementalGraph state is lifecycle-owned. A supported local database changes only through the controlled transitions in this specification. Raw filesystem/database manipulation, partial external restoration, or rollback to an older local database image are not lifecycle transitions.

Complete disappearance of the local database is the supported external-loss case. It produces the **Absent** lifecycle state and may enter the controlled restore/fresh-creation path. This fault-model boundary is `$id-6158827469032147`.

## 2. Lifecycle states

A local installation is in one of these lifecycle states:

- **Absent** — no supported local database/writer identity is present locally, including after complete loss of the local database;
- **Legacy/migratable** — a structurally valid supported pre-Journal database exists;
- **Current** — active database version/schema match the running application and graph equals Journal replay;
- **Incompatible for an operation** — independently valid state cannot participate in the requested sync/reset/migration/bootstrap boundary; or
- **Corrupted/unsupported** — required invariants fail, state was produced outside supported transitions, or local persistent state has been partially deleted, rolled back, mixed, or externally modified.

Supported transitions include:

1. absent-state restoration of this installation's synchronized history;
2. fresh creation when no such history exists;
3. open;
4. ordinary graph evolution;
5. pre-Journal bootstrap;
6. Journal-aware migration;
7. synchronization;
8. controlled reset; and
9. projection rebuild from valid authoritative Journal history.

A successful startup reaches **Current** before graph-backed APIs are exposed.

A process/power crash during a supported transition does not create a new arbitrary lifecycle state. The transition's atomicity/crash rules must ensure that any state later exposed for supported use is itself one of the valid states permitted by that transition. If storage damage instead produces a partial or rolled-back database, that state is corrupted/unsupported rather than a new recovery case.

## 3. Startup flow

Conceptually startup performs:

1. validate required operating context;
2. determine whether supported local database state is completely absent or exists;
3. if local state is absent, run the absent-state decision below;
4. otherwise open the existing state sufficiently to read version/current committed-pair metadata and validate the lifecycle boundary;
5. run the migration/bootstrap gate when required;
6. for an already-current supported database, perform only the bounded routine-open checks in §6; run full replay/rebuild only as part of an explicit transition which requires it; and
7. expose IncrementalGraph APIs.

Startup never silently reinterprets malformed, partially missing, rolled-back, incompatible, or otherwise unsupported existing state as absence or as a fresh database.

Routine startup of an already-current local database does not imply ordinary multi-source synchronization unless outer application policy explicitly requests it.

Maintenance transitions are exclusive with ordinary graph activity at their publication/cutover boundary.

## 4. Absent-state decision

This section applies only when the local IncrementalGraph database is completely absent. An existing but damaged, truncated, or older local database does not enter this path.

The absent-state decision happens **before generating a new DatabaseFingerprint**.

The outer lifecycle obtains a transport-neutral `InstallationRecoverySource` capable of answering whether recoverable synchronized state exists for **this installation**. The source is an abstraction: an implementation may construct it from one storage location, several locations, a Git-backed transport, a hosted service, files, or another persistence topology.

The IncrementalGraph database does not persist a hostname, Git branch, repository locator, or other transport identity for this source. Outer transport/lifecycle code may use deployment configuration such as a hostname to construct or locate the source, but those locators stay outside the persisted database and outside the `InstallationRecoverySource` semantic interface, consistent with `$id-4373538486707762`.

### 4.1 Query the installation recovery source

Startup obtains exactly one of:

1. **source exists** — open/hold that source's stable database snapshot and restore it;
2. **source definitely does not exist** — fresh creation is allowed;
3. **query/read failed or result is indeterminate** — startup fails.

Failure to query or obtain known synchronized state MUST NOT fall back to fresh creation.

Fresh creation after `DefinitelyAbsent` assumes one live owner of this installation's lifecycle/database. Two concurrent processes independently claiming the same installation are outside the supported locking/lifecycle model and must be excluded by outer installation ownership. This differs from canonical cohort bootstrap, where multiple legitimate legacy installations may race and therefore require conditional publication arbitration.

For writer A, call a held recovery snapshot with `frontier[A] = q` **continuation-safe at q** iff, after restoring the completely absent installation from that snapshot, no previously authored A record with sequence greater than q can later enter supported retained history for writer A.

This is a property required only for absent-state restoration. It is not a mechanism for repairing an existing local database that has gone backwards. Journal 3 does **not** prescribe one mechanism for establishing the property. A recovery source may return `Exists(ContinuationSafeSnapshot)` only when the guarantees of its supported backend model imply that q is safe.

The supported backend model is allowed to rule out histories which cannot actually arise or later re-enter under that backend. Recovery is not required to defend against every imaginable storage topology. For example, a backend may establish continuation safety because surviving writer history can only propagate through a monotonic publication path; another backend could establish the same property using a different protocol, replicated metadata, consensus, leases, or another mechanism. None of those mechanisms is part of Journal semantics.

A record that existed only on the completely lost local storage need not count against continuation safety when the supported backend model guarantees that no surviving copy can later reintroduce it. Conversely, if a higher A record remains admissible under the supported backend model and can later re-enter retained history, q is not continuation-safe.

This is also the recovery boundary required by `$id-2567281946348705`: a writer coordinate beyond q may be reused only when its previous record cannot later coexist with, or be combined with, the restored continuation in a supported execution.

Journal 3 does not require contacting or discovering every possible peer to establish continuation safety, consistent with `$id-4719065396881648`.

#### Current Git-backed transport as an example

The current Git-backed transport is one way to satisfy the abstract absent-restoration contract; this paragraph is explanatory, not a required Journal topology.

In the supported flow, an installation renders/publishes its database through its transport-managed remote branch before another installation can obtain that published writer history through the same synchronization transport. The branch/location mapping is transport configuration and is not stored in IncrementalGraph state. Under the normal supported Git persistence model, successfully published branch history is not silently rewound while still being treated as ordinary recoverable state.

Therefore a writer record which survives complete loss of the local database on some other participating installation must already have passed through the remote publication path. Local records written after the last successful publication but lost with the complete local database may disappear permanently. Their writer sequence coordinates, and local NodeIdentifier indices whose allocations are represented only by that discarded suffix, may be reused after absent-state restoration.

If the remote repository itself is silently rolled back, loses previously published commits, or is externally rewritten while surviving replicas still retain the removed writer records, that violates the assumptions of this Git-backed recovery model. Such storage damage is outside ordinary lifecycle recovery.

Continuation safety protects allocator identity as well as writer coordinates. The recoverable writer prefix carries the `last_node_index` watermark that remains reserved. If a higher allocation can later re-enter supported retained history, the older recovery point is not safe; if the higher allocation existed only in the discarded suffix and cannot re-enter, its index may be allocated again. This is the supported-history uniqueness rule of `$id-4173361406347342`: reuse is allowed only when the two meanings cannot coexist in, or later join, any supported retained state.

### 4.2 Receiver-less restore

Restoring an absent installation is conceptually:

```text
restoreAbsentFrom(source) -> Current-or-Migratable local database
```

It is not `synchronizeFrom()` or `resetTo()` because those operations require an already-established writable receiver identity.

The held source snapshot supplies the continuing installation identity:

```text
localWriter = snapshot.localWriter
```

and MUST establish a continuation-safe head under §4.1 before this installation may author another record under that writer.

Restore retains the source history and reconstructs:

- local writer head;
- local `last_node_index` reconstructed from the retained writer prefix;
- authority high-water;
- materialized graph; and
- derived indexes/caches.

The reconstructed `last_node_index` may be lower than the destroyed database's final local watermark when the missing suffix is continuation-safe to discard under §4.1. No new semantic record is required merely to restore exact retained history.

The restored snapshot may be at an older supported Journal version. Startup then runs the normal migration gate before exposing graph APIs.

### 4.3 Fresh creation only after definite absence

Only definite absence permits fresh creation.

Fresh creation:

- generates one new durable `DatabaseFingerprint`;
- starts at local writer frontier zero;
- retains no foreign history;
- materializes an empty graph;
- initializes local `last_node_index` under the ordinary allocator contract; and
- records current version/schema metadata.

Thus:

```text
project(empty journal) = empty graph
```

## 5. Existing local state never uses rollback recovery

An existing supported local database is authoritative for its own local-writer prefix. The lifecycle does not contain a transition which repairs an existing database by importing a missing suffix of its own writer after local rollback or partial data loss.

Therefore, if local writer A retains `A:1..p` but a synchronization/reset source contains an agreeing `A:1..q` with `q > p`, this does not mean that A is a supported "behind writer" awaiting recovery. It is evidence that one of the lifecycle assumptions has been violated—for example partial local rollback/loss, unsupported cloning, or externally manipulated persistence.

Such an operation must fail without authoring new A records or silently repairing the receiver. `JournalWriterBehindError` may be used as the specific diagnostic for this condition, but it denotes corrupted/unsupported lifecycle state rather than a recoverable normal state.

Likewise, overlap disagreement for one writer coordinate is a writer fork and is unsupported.

More strongly, supported lifecycle closure implies **writer-prefix comparability** across any states which may coexist or later combine: for each writer A, one retained A stream is a prefix of the other, and every shared coordinate has the same immutable record. A partial fork—two such states agreeing through A:1..k and then retaining distinct A:k+1 records—is therefore impossible in supported state.

This follows from serialized append-only authoring, immutable foreign-record import, continuation-safe absent restoration, canonical bootstrap arbitration, deterministic canonical migration, and the exclusion of rollback/cloning/external mutation. The accepted fingerprint-collision tradeoff in `$id-9051842763146802` does not weaken this supported-state rule: an actually observed same-fingerprint divergent pair is classified unsupported.

Ordinary sync/reset may rely on this lifecycle consequence and need not rescan unrelated historical overlap merely to re-prove it; `incremental-graph-journal-theorems.md` Laws 8 and 8a state the derived proof obligations.

Two independently live installations intentionally authoring under one fingerprint are unsupported.

The separate creator-resume rule in §8.2 is not an exception: it handles interruption of the one controlled pre-Journal bootstrap transition before an active Journal database exists, and its permitted states are explicitly defined by that transition.

## 6. Opening current Journal state

Opening a current Journal database selects one coherent atomically published pair:

```text
(retained journal, materialized projection)
```

The pair is already required, by the lifecycle transitions that produced it, to satisfy contiguous writer streams, current-format decoding, causal/reference validity, replay equivalence, and allocator/authority invariants. Routine open does not re-prove those facts by scanning retained history.

Under `$id-7429043816351276`, routine Journal-specific open work for an already-current supported database is `O(1 + G)`, where G is current materialized graph plus graph-bounded current-state metadata and excludes retained history/history-proportional Journal indexes. The bound is independent of retained Journal size H. Routine open checks only current version/schema compatibility, constant-size/current-state metadata identifying the selected atomically committed pair, local writer head, allocator watermark, authority high-water, and current graph/index consistency work bounded by G.

Routine open MUST NOT perform a full Journal replay or complete historical well-formedness scan solely to establish `graph == project(journal)`. That equality was established at the successful publication/import/bootstrap/restore/migration/reset cutover which selected the active pair.

Known graph/Journal disagreement is not exposed as ordinary current state. Missing or inconsistent committed-pair metadata causes startup failure or an explicit supported maintenance/rebuild transition; explicit rebuild may replay/validate retained history before exposure and is not subject to the routine-open history-independence bound.

A local Journal stream with a missing/truncated tail is not normalized into a shorter valid history merely because some retained prefix appears internally usable. If supported metadata/evidence shows that this installation previously authored a longer local prefix, the local state is corrupted/unsupported under §5.

## 7. Ordinary evolution

Ordinary graph operations append replay-complete Journal history according to `incremental-graph-journal-emission.md`.

For every successful committed semantic transition:

```text
project(journalAfter) == graphAfter
```

Graph/Journal publication is atomic. Failed operations consume no durable Journal coordinate. A crash may expose only states permitted by the operation's transaction/publication boundary; it does not make a partially committed Journal/projection pair a supported state.

A successful operation which changes no persisted semantic state need not append a semantic event merely because the API was invoked.

## 8. Migration and bootstrap gate

Detailed bootstrap/migration rules are normative in `incremental-graph-journal-migrations.md`.

### 8.1 Gate decision

After reading stored database version:

- matching current Journal version -> no migration;
- supported older Journal version -> resolve and execute the canonical Journal migration chain from that stored version to the running version, as defined by `incremental-graph-journal-migrations.md` §9b;
- older Journal version without a complete canonical chain to the running version -> fail `JournalVersionCompatibilityError`;
- unsupported version -> fail;
- supported pre-Journal state -> run the canonical-bootstrap-source decision below.

Absence of stored version is treated as fresh only under genuine fresh-creation rules; it does not erase structured existing state whose metadata is malformed/missing.

For every supported pre-Journal source version, the release identifies one expected **Journal bootstrap target version/schema**.

That bootstrap transition is a **graph-semantic identity transition**. It may change whole-database representation to introduce Journal storage, but before the canonical cut it does not execute an ordinary graph migration. The persisted pre-Journal graph already supplies the bootstrap semantic state: materialized NodeKeys, NodeIdentifiers, payloads, timestamps, freshness, validity, `last_node_index`, and graph interpretation are preserved exactly.

Therefore a source/target pair which would require `MigrationStorage.create()`, `invalidate()`, `delete()`, a schema-semantic rewrite, wall-clock output, fresh allocator-dependent graph identity, randomness, or another semantic migration callback result **before Journal identity exists** is not a supported automatic bootstrap path. Startup fails `JournalVersionCompatibilityError` before authoring history.

Representation-only change is not a separate pre-Journal decision in this lifecycle. Actual graph/schema/representation migration runs only after Journal bootstrap as an ordinary Journal-aware migration using the canonical whole-history codec and semantic decisions such as `keep`.

The running release is not required to retain legacy bootstrap support forever. An artifact whose target version/schema is not exactly the release's expected bootstrap target fails compatibility before history is authored.

### 8.2 Pre-Journal multi-host bootstrap

Replicas expected to synchronize after Journal introduction use one canonical semantic bootstrap history as the shared ValueId basis for occurrences equal to the canonical cut.

The configured transport-neutral cohort bootstrap source first answers:

1. **canonical artifact exists** — validate it, then choose creator-resume or ordinary join based on writer identity;
2. **source definitively does not exist** — stage a deterministic canonical candidate, but do not cut over;
3. **query failed or result is indeterminate** — fail and MUST NOT create competing canonical history.

A definite-absence query is not first-creator arbitration. The creator must conditionally publish the staged candidate through `publishCanonicalBootstrapIfAbsent`, whose semantic outcomes are:

1. **Published(B)** — B is the one durable canonical artifact; after validating that B is the staged candidate, local creator cutover may proceed;
2. **AlreadyExists(B)** — another attempt already selected the canonical artifact; discard the losing candidate and use creator-resume iff B belongs to the local fingerprint, otherwise ordinary join;
3. **IndeterminateOrError** — do not cut over. Keep the supported pre-Journal database active and re-query before any retry.

This conditional publication is the arbitration required by `$id-1847369205416728`: concurrent distinct candidates cannot both become accepted canonical histories for one cohort.

The creator freezes its candidate at the exact frontier immediately after bootstrap. Ordinary Journal authoring remains disabled until conditional publication returns `Published` and local cutover succeeds.

Before create-resume/join interpretation require:

```text
canonical.databaseVersion   == expectedBootstrapTargetVersion
canonical.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

and require the semantic-identity bootstrap contract from §8.1. Incompatibility is `JournalVersionCompatibilityError` before semantic history is authored.

#### Creator resume

Creator resume is specified by `incremental-graph-journal-migrations.md` §6.

#### Ordinary joining installation

Joining is specified by `incremental-graph-journal-migrations.md` §7.

### 8.3 Journal-aware migration

Journal-aware migration is specified by `incremental-graph-journal-migrations.md` Part II (§§9–22). The lifecycle requirement is only that it runs as exclusive maintenance and cuts over atomically; failure leaves the previous active pair selected.

## 9. Synchronization

Ordinary synchronization requires an established receiver and one held source `JournalSnapshot` with exact compatibility from the same immutable cut:

```text
snapshot.databaseVersion == receiver global/version
snapshot.graphSchemeString == receiver global/graph_scheme
```

The procedure is specified by `incremental-graph-journal-sync.md`.

No computor executes during sync.

A completely absent installation uses §4, not ordinary sync. A pre-Journal installation completes §8.2 before ordinary sync.

## 10. Controlled reset

Controlled reset is specified by `incremental-graph-journal-reset.md`.

It means:

> make the receiver's projected graph equal to a chosen compatible source projection relative to all history currently observed

without deleting retained history.

If the held reset source is ahead for the receiver's own local writer, reset fails `JournalWriterBehindError` before importing/authorship. This is the same corrupted/unsupported lifecycle condition as §5; reset does not repair it and there is no existing-writer rollback-recovery transition.

A completely absent installation does not use reset. Pre-Journal bootstrap join is also not reset: divergent bootstrap values represent pre-existing legacy facts and do not inherit reset's causally-later target-repair semantics.

## 11. Projection rebuild

Maintenance may rebuild graph/index state from valid retained Journal history under exclusive ownership.

It may recreate graph sublevels and derived indexes/caches, but must not rewrite authoritative Journal meaning merely to make replay succeed.

Projection rebuild repairs derived-state loss only. It is not a supported way to repair missing/truncated authoritative Journal history, rollback of the active database, or an externally mixed database image.

If authoritative history is invalid/forked or known incomplete, rebuild fails.

## 12. User/API expectations

### `pull()`

May recompute and append Journal events. Success implies matching graph/history are durably published.

### `invalidate()`

Records invalidation/staleness without recomputing the target. Ordinary explicit invalidation remains node-scoped.

### inspection

Reads materialized projection without invoking computors merely for diagnostics.

### synchronization

May change selected values, identifiers, freshness, validity, and materialization by importing/replaying foreign-writer history and authoring required normalization; never invokes computors. It does not repair rollback of the receiver's own writer stream.

### reset

May intentionally rebaseline observable graph state while retaining history. Success is atomic. It does not serve as raw database rollback recovery.

### migration/startup

Graph APIs are not initialized until any required absent restore, bootstrap, migration, or explicit rebuild/replay-validation transition completes. Routine opening of an already-current supported database follows §6 and does not add full replay validation.

## 13. Trust and storage-fault model

Supported participants are non-adversarial but may be stale, interrupted, offline, delayed, or incompatible.

Local persistent database state is assumed to be changed only through supported Volodyslav transitions, except that the complete local database may disappear. Complete disappearance maps to **Absent** and is recoverable through §4. Arbitrary partial filesystem loss, replacement with an older database image, mixed snapshots, manual edits, or storage corruption are not modeled as normal lifecycle evolution.

Correctness still rejects malformed state, writer forks, non-closed causal contexts, broken reference causality, Journal/projection invariant failure, and evidence that the local writer has lost an already-surviving suffix.

Journal 3 does not require Byzantine provenance, malicious-peer containment, general partial-corruption repair, or semantic recovery from arbitrary filesystem damage.

## 14. Unsupported operations and states

Unsupported operations/states include:

- manually editing Journal records;
- changing one same-version record's semantic meaning while keeping its ID;
- partial deletion of a local database;
- replacing an existing local database with an older snapshot or backup;
- mixing records/files from different database moments;
- partially restoring local storage while retaining some old state;
- mixed record formats in one active replica;
- destructive authoritative-history truncation followed by continued same-writer authoring;
- independently cloning one writer identity into multiple live writers;
- an existing receiver whose own writer prefix is shorter than surviving supported history for that writer;
- persisting hostnames, Git branch names, repository locators, or other transport identities as IncrementalGraph implementation-owned database/recovery metadata;
- manually editing graph sublevels away from Journal replay;
- bypassing required Journal-aware version migration;
- forcing ordinary sync/reset across incompatible snapshot metadata;
- using an arbitrary current Journal snapshot in place of frozen canonical bootstrap artifact;
- joining a canonical artifact whose target version/schema the running release does not support;
- running a semantic/time/allocator-dependent legacy migration callback before canonical bootstrap identity is established;
- independently creating a second canonical pre-Journal bootstrap after canonical artifact already exists;
- making a late legacy value causally later solely because bootstrap code observed canonical artifact;
- using creator-resume under a fingerprint other than `artifact.creatorWriter`;
- rerunning legacy migration callbacks during creator-resume;
- continuing creator-resume when artifact projection and persisted legacy semantic state disagree;
- using a maintenance proof barrier with node scope when no actual node invalidation occurred;
- using a whole-ValueId proof barrier when only specific incoming proof edges are being retired;
- using a non-total format codec which cannot rewrite retained history for target-removed node families; and
- treating a checkpoint as replacement authority for missing authoritative history.

Backend-specific violations which invalidate an absent-restoration source's continuation-safety assumptions—such as silent loss or rollback of durable writer history in a backend model that assumes monotonic publication—are likewise outside ordinary lifecycle recovery.

Any future recovery/import behavior for a currently unsupported storage-damage case must first change `$id-6158827469032147` and then introduce an explicit controlled transition with stated invariants.

## 15. Corruption versus incompatibility

A database may be valid independently yet incompatible with one requested operation.

Corruption/unsupported evidence includes:

- same writer/sequence with different bodies;
- committed stream holes;
- evidence that an existing local writer previously had a longer surviving prefix than the current local state;
- partial/mixed/rolled-back local persistent state;
- non-closed semantic-event contexts;
- mixed current record formats;
- impossible ValueId references;
- incompatible current NodeIdentifier reuse;
- creator-resume artifact/local-legacy semantic disagreement;
- graph known to disagree with replay without successful derived-state rebuild; and
- local allocator state which could reallocate an index whose earlier allocation can exist in or later enter supported retained history.

Incompatibility includes:

- a pre-Journal source/target bootstrap pair which cannot preserve persisted graph semantics exactly without running semantic/time/allocator-dependent migration logic before Journal identity exists; and
- a Journal-aware source/target version pair whose canonical codec is not total over retained source history.

Operations fail where such evidence becomes relevant. They must not silently convert corruption/unsupported state or incompatibility into absence, a fresh database, or ordinary graph conflict.
