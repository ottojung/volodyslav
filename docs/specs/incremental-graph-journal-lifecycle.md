---
title: Database Lifecycle
---

# Volodyslav Database Lifecycle

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
4. otherwise open the existing state sufficiently to read version metadata and validate the lifecycle boundary;
5. run the migration/bootstrap gate when required;
6. validate/rebuild Journal-derived projection state when applicable; and
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

For writer A, call a held recovery snapshot with `frontier[A] = q` **continuation-safe at q** iff, after restoring the completely absent installation from that snapshot, no previously authored A record with sequence greater than q can later enter supported retained history for writer A.

This is a property required only for absent-state restoration. It is not a mechanism for repairing an existing local database that has gone backwards. Journal 3 does **not** prescribe one mechanism for establishing the property. A recovery source may return `Exists(ContinuationSafeSnapshot)` only when the guarantees of its supported backend model imply that q is safe.

The supported backend model is allowed to rule out histories which cannot actually arise or later re-enter under that backend. Recovery is not required to defend against every imaginable storage topology. For example, a backend may establish continuation safety because surviving writer history can only propagate through a monotonic publication path; another backend could establish the same property using a different protocol, replicated metadata, consensus, leases, or another mechanism. None of those mechanisms is part of Journal semantics.

A record that existed only on the completely lost local storage need not count against continuation safety when the supported backend model guarantees that no surviving copy can later reintroduce it. Conversely, if a higher A record remains admissible under the supported backend model and can later re-enter retained history, q is not continuation-safe.

Journal 3 does not require contacting or discovering every possible peer to establish continuation safety, consistent with `$id-4719065396881648`.

#### Current Git-backed transport as an example

The current Git-backed transport is one way to satisfy the abstract absent-restoration contract; this paragraph is explanatory, not a required Journal topology.

In the supported flow, an installation renders/publishes its database through its transport-managed remote branch before another installation can obtain that published writer history through the same synchronization transport. The branch/location mapping is transport configuration and is not stored in IncrementalGraph state. Under the normal supported Git persistence model, successfully published branch history is not silently rewound while still being treated as ordinary recoverable state.

Therefore a writer record which survives complete loss of the local database on some other participating installation must already have passed through the remote publication path. Local records written after the last successful publication but lost with the complete local database may disappear permanently. Their writer sequence coordinates, and local NodeIdentifier indices whose allocations are represented only by that discarded suffix, may be reused after absent-state restoration.

If the remote repository itself is silently rolled back, loses previously published commits, or is externally rewritten while surviving replicas still retain the removed writer records, that violates the assumptions of this Git-backed recovery model. Such storage damage is outside ordinary lifecycle recovery.

Continuation safety protects allocator identity as well as writer coordinates. The recoverable writer prefix carries the `last_node_index` watermark that remains reserved. If a higher allocation can later re-enter supported retained history, the older recovery point is not safe; if the higher allocation existed only in the discarded suffix and cannot re-enter, its index may be allocated again.

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

Two independently live installations intentionally authoring under one fingerprint are unsupported.

The separate creator-resume rule in §8.2 is not an exception: it handles interruption of the one controlled pre-Journal bootstrap transition before an active Journal database exists, and its permitted states are explicitly defined by that transition.

## 6. Opening current Journal state

Opening a current Journal database establishes one coherent pair:

```text
(retained journal, materialized projection)
```

Supported state requires at least:

- contiguous writer streams;
- one current record format selected by `global/version`;
- transitively closed semantic-event contexts;
- current version/schema compatible with running interpretation;
- graph observationally equivalent to replay, or successfully rebuilt before exposure; and
- local writer allocator state consistent with retained local history.

Known graph/Journal disagreement is not exposed as ordinary current state.

A local Journal stream with a missing/truncated tail is not normalized into a shorter valid history merely because the retained prefix is internally contiguous. If supported evidence shows that this installation previously authored a longer local prefix, the local state is corrupted/unsupported under §5.

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

The configured transport-neutral cohort bootstrap source returns exactly one of:

1. **canonical artifact exists** — validate it, then choose creator-resume or ordinary join based on writer identity;
2. **source definitively does not exist** — `createCanonicalBootstrap` is allowed;
3. **query failed or result is indeterminate** — fail and MUST NOT create competing canonical history.

A definite-absence answer is valid only when suitable for first-creator arbitration. Distinct canonical artifacts for one cohort are unsupported and require explicit recovery rather than payload-based merge.

The creator freezes the canonical artifact at the exact frontier immediately after bootstrap and before ordinary Journal authoring. `createCanonicalBootstrap` does not report success until that artifact is durable.

Before create-resume/join interpretation require:

```text
canonical.databaseVersion   == expectedBootstrapTargetVersion
canonical.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

and require the semantic-identity bootstrap contract from §8.1. Incompatibility is `JournalVersionCompatibilityError` before semantic history is authored.

#### Creator resume

If:

```text
canonical.creatorWriter == local DatabaseFingerprint
and local state is still supported pre-Journal state
```

startup resumes interrupted canonical creation rather than joining as a second writer.

It:

1. reads exactly artifact records through `bootstrapFrontier`;
2. projects the artifact with `localWriter = artifact.creatorWriter`;
3. validates the still-local persisted legacy graph directly under the semantic-identity bootstrap interpretation; it does **not** rerun a migration callback;
4. requires equality of presence, payloads, NodeIdentifiers, timestamps, freshness, validity, and allocator state required by the bootstrap contract;
5. on mismatch fails `JournalBootstrapForkError` and authors/cuts over nothing;
6. on equality installs exactly artifact history, reconstructs writer head/`last_node_index`/authority high-water/projection/indexes, and atomically cuts over; and
7. resumes the ordinary migration gate from the installed Journal version.

This closes the crash window where canonical artifact publication succeeded but local Journal cutover did not.

A different fingerprint MUST NOT use creator-resume.

#### Ordinary joining installation

Join uses exactly the frozen canonical cut, never later current cohort history.

A divergent legacy value is not made causally later merely because its host upgrades later. Join:

- reuses canonical ValueId for exact equal occurrences;
- converts local-only/different persisted legacy occurrences into historical joining-writer bootstrap ValueEvents seeded by their own legacy `modifiedAt`;
- uses normal Journal authority for conflicting concurrent occurrences;
- does not treat one legacy cache's absence as deletion evidence; and
- preserves the joining writer fingerprint/allocator watermark.

For an **exact shared occurrence**, positive validity is merged conservatively by intersection:

```text
joinedValid(K) = canonicalValid(K) intersect joiningValid(K)
```

The canonical certificate remains the positive proof basis. For every canonical incoming edge absent from the joining legacy proof, join authors an occurrence-and-input-specific `proof(value,input)` barrier. Join never adds an edge missing on the canonical side merely because the joining side has it, and it does not author a causally-later validation merely to strengthen the joining host's proof.

Shared freshness is also conservative:

```text
joined shared occurrence stale
    iff canonical legacy copy stale OR joining legacy copy stale
```

An uncovered value-scoped bootstrap invalidation is retained/authored after those proof-edge barriers when required, so a fresh joining copy cannot clear canonical stale state and a stale joining copy can make a canonical-fresh shared occurrence stale without changing ValueId.

After direct stale/proof roots are represented, join performs the bootstrap propagated-staleness pass over the selected dependency DAG. If selected K has complete own **effective** proof (`selfProofReady`) but is stale because a direct input is stale, join ensures an uncovered value-scoped bootstrap invalidation exists for current `valueId(K)`. This applies to canonical-only, joining, and shared selected occurrences. Consequently a later upstream `Unchanged` cannot silently freshen a dependent which became persistently stale during bootstrap merge.

Two independent late joiners with the same occurrence that differs from the canonical cut may assign distinct bootstrap ValueIds. Later synchronization may stale dependents naming the losing occurrence. This accepted limitation is `$id-1635227135166767`.

After the bootstrap-target pair is installed, startup continues through Journal-aware migrations explicitly supported by the running release. Post-bootstrap cohort history enters later through ordinary synchronization once versions are compatible.

No particular remote host needs to reconcile, acknowledge, or return merely for bootstrap to complete.

### 8.3 Journal-aware migration

A Journal-aware migration:

1. validates source Journal/projection under source version;
2. deterministically rewrites **every retained record**, including history for node families removed from the target schema, into target representation while preserving IDs/meaning;
3. applies one pure per-record payload rewrite to every affected retained ValueEvent regardless of selected status;
4. computes target graph under isolated target storage;
5. preserves ValueIds for occurrence-preserving semantic decisions such as `keep` and `invalidate`; representation-only change is handled by the canonical whole-history codec;
6. creates new ValueEvents only for actual new/replaced semantic occurrences;
7. preserves true explicit `invalidate(K)` as a node-scoped invalidation;
8. when maintenance merely weakens proof for preserved occurrence V, authors one occurrence-and-input-specific `scope={kind:"proof",value:V,input:D}` barrier for every removed incoming edge D rather than a node-wide or whole-certificate invalidation;
9. persists target propagated-stale state with value-scoped invalidation whenever a target-stale occurrence's own effective proof is otherwise complete, even when it is already recursively stale through an input;
10. verifies target replay; and
11. atomically cuts over.

The representation codec MUST be total over retained source-version history. If any retained record—including one for a node family absent from the target schema—has no deterministic target representation, migration fails `JournalVersionCompatibilityError` before cutover.

Proof-edge barriers affect only the named input edge of the named ValueId. Concurrent barriers for the same V compose by removing the union of the edges they name; they do not destroy unrelated proof entries or proof for another replacement ValueId.

Journal-aware migration does not require a canonical migration participant. Independently migrated replicas may author different ValueIds for genuinely replaced occurrences; later synchronization may stale dependents which named a losing occurrence. This is accepted.

Future replay does not rerun historical migration callbacks.

## 9. Synchronization

Ordinary synchronization requires an established receiver and one held source `JournalSnapshot` with exact compatibility from the same immutable cut:

```text
snapshot.databaseVersion == receiver global/version
snapshot.graphSchemeString == receiver global/graph_scheme
```

A pairwise sync:

1. enters required maintenance ownership;
2. opens one stable source snapshot;
3. checks compatibility from that snapshot;
4. if the source has a longer prefix of the receiver's own local writer, fails `JournalWriterBehindError` as evidence of corrupted/unsupported lifecycle state under §5;
5. streams missing immutable foreign-writer suffixes;
6. validates overlap, contiguity, causal closure, authority, and references;
7. performs required receiver-authored semantic normalization;
8. replays/validates final projection; and
9. atomically publishes Journal + projection.

No computor executes during sync.

A completely absent installation uses §4, not ordinary sync. A pre-Journal installation completes §8.2 before ordinary sync.

## 10. Controlled reset

Controlled reset is specified by `incremental-graph-journal-reset.md`.

It means:

> make the receiver's projected graph equal to a chosen compatible source projection relative to all history currently observed

without deleting retained history.

If the held reset source is ahead for the receiver's own local writer, reset fails `JournalWriterBehindError` before importing/authorship. This is the same corrupted/unsupported lifecycle condition as §5; reset does not repair it and there is no existing-writer rollback-recovery transition.

Reset preserves an already-selected value occurrence when immutable semantic occurrence state already matches target. It authors new ValueEvents only where occurrence itself must change.

When reset merely removes incoming validity for a preserved occurrence V, it authors one occurrence-and-input-specific **proof-edge barrier** for each removed edge before any target validation. It does not use a node-scoped invalidation merely as a certificate-selection device.

If reset target stores a node stale while its own effective proof is otherwise complete, reset persists that stale state with a value-scoped invalidation even when recursive replay is already stale through an input.

An unseen concurrent event may later affect ordinary synchronization normally; a reset proof-edge barrier for one ValueId/input does not taint unrelated proof or certificates for another occurrence.

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

Graph APIs are not initialized until required absent restore/bootstrap/migration/replay validation completes.

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
