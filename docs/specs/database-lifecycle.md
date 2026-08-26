---
title: Database Lifecycle
---

# Volodyslav Database Lifecycle

## 1. Overview

This document specifies the supported lifecycle of Volodyslav's synchronized incremental database. It describes how the database is created, opened, changed, migrated, synchronized, and rejected when its state is incompatible with the requested operation.

This is a lifecycle specification, not a storage-format specification. Physical directories, rendered snapshots, replica names, key layouts, indexes, and allocation mechanisms are implementation details unless another specification explicitly makes one of them normative. The lifecycle rules in this document must continue to hold if those mechanisms change.

The normal user-facing operation is:

```sh
volodyslav start
```

Creation, restoration from a synchronized host, migration, and other import-like behavior are Volodyslav-controlled transitions reached through startup or synchronization. Raw filesystem manipulation is not a database lifecycle operation.

Other persistent subsystems, such as assets and runtime scheduler state, have their own lifecycle rules. They may be synchronized during the same application operation, but they are outside the database state governed by this specification.

Normative terms such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe the supported model. A statement that a state "cannot happen" means that it cannot happen through a supported Volodyslav lifecycle transition.

For the journal subsystem, "supported" means produced by lifecycle transitions
of a journal-enabled implementation satisfying the journal specifications. As
specified by the journal's
[implementation/rollout scope](../incremental-graph-journal.md#implementationrollout-scope),
a state created by pre-journal software is outside that journal-state universe
until deployment establishes the target persistent representation. This is not
an operational declaration that an older database is corrupt; its upgrade is a
deployment compatibility concern outside these semantic lifecycle transitions.

## 2. Lifecycle states and transitions

At the lifecycle level, a database is in one of these states:

- **Absent**: no local live database has been established for this installation.
- **Current**: the local database is openable, structurally usable, and recorded at the database version expected by the running application.
- **Migratable**: the local database is structurally usable but records a different database version for which the running application supplies a migration procedure.
- **Incompatible for an operation**: the database may be meaningful on its own, but a requested migration or synchronization does not have satisfied compatibility preconditions.
- **Corrupted or unsupported**: the state was not produced by a supported lifecycle transition, or a lifecycle precondition was violated while producing it.

The supported transitions are:

1. **Bootstrap**: absent local state becomes a local database through a Volodyslav-controlled restore or fresh creation path.
2. **Open**: existing local state is opened and its required lifecycle metadata is interpreted.
3. **Ordinary evolution**: application operations transactionally update the current database while preserving graph and persistence invariants.
4. **Migration**: a usable older database is transformed to the current application version and committed by a controlled cutover.
5. **Synchronization**: a stable local database is checkpointed and exchanged with compatible host states, then reopened through the migration gate.
6. **Controlled reset**: a synchronization path selects a host snapshot as the new logical state and commits it through the database abstraction.

A successful startup ends in the **Current** state before the database-backed application interface is exposed as initialized. Failure to satisfy a transition's preconditions aborts that transition; Volodyslav MUST NOT silently reinterpret an incompatible or unsupported state as a fresh database.

## 3. Startup flow

`volodyslav start` initializes the server and its required environment, system capabilities, and application services. Database initialization is a required startup dependency. If database initialization fails, application initialization does not complete successfully.

Database startup follows this sequence:

1. **Validate operating context.** Required environment configuration is read before normal database use. This includes a working location, synchronization repository, and a valid local hostname. Required external capabilities, including Git, must be available.
2. **Determine whether local live state exists.** Existence is a bootstrap decision only. Existing state is opened; it is not overwritten by a remote snapshot merely because startup is occurring.
3. **Bootstrap when absent.** Volodyslav selects one of the controlled creation paths described in [Database creation](#4-database-creation).
4. **Open the local database.** The database implementation opens the durable state and establishes the active logical state. Required structural metadata must be valid enough to identify and load that state.
5. **Run the migration gate.** A fresh database is marked with the running database version. A database already at that version proceeds unchanged. A database at a different version must complete migration.
6. **Construct and expose the incremental graph.** The database-backed graph interface becomes initialized only after opening and migration have succeeded.

Startup does **not** perform an ordinary synchronization when local live state already exists. Synchronization is a separate controlled operation. This distinction prevents routine startup from unexpectedly replacing or merging local state and makes migration the only version-changing startup transition.

Initialization is exclusive with database maintenance operations. Concurrent ordinary reads or writes must not observe a partially bootstrapped, migrating, resetting, or synchronizing database.

## 4. Database creation

### 4.1 Preconditions

Supported creation requires:

- an initialized Volodyslav environment;
- a valid local hostname, used to identify this host's synchronized history;
- an accessible configured synchronization repository;
- functioning required filesystem, database, and Git capabilities; and
- exclusive execution of the bootstrap transition for the working location.

The synchronization repository is part of creation even when the resulting database is empty. Absence of local state does not authorize bypassing repository or hostname checks.

### 4.2 Restoring this host's synchronized state

When local live state is absent, Volodyslav first asks whether the synchronization repository contains the current synchronized state previously published for this same host and writer. The synchronization lifecycle must recognize the selected branch as the branch assigned to the current host/writer.

This is **absent-state self-restoration**, not reset of an existing database. It
restores and validates the authoritative graph together with the durable local
`DatabaseFingerprint`,
journal entries, `journalCoverage`, and `localJournalClock`. Absent-state
self-restoration accepts the retained journal representation published by a
supported synchronization checkpoint whether or not canonical compaction ran
before that checkpoint. It preserves the immutable collection and vector coordinates exactly:
restoration neither requires `J == compact(J)` nor implicitly compacts, authors,
re-authors, merges, or migrates journal history.

Before installation, restoration validates the ordinary load structure:

- the durable `DatabaseFingerprint` belongs to
  the selected host/writer branch;
- retained generation references resolve correctly, and every generation's named initial freshness event has the same author, a greater sequence, the same derived `entryNodeKey`, and the generation's exact ID;
- every retained value-specific freshness assertion resolves its exact same-key/generation value-origin event; reset-lineage consumed source identities need not be locally retained, but their coordinate shapes and authoring provenance must validate;
- live `NodeIdentifier` values are unique and bijective with live semantic keys, and no retired identifier is live;
- every materialization origin is the admissible canonical event for its winning generation and `modifiedAt`, rather than a superseded same-author head or lower equal-time candidate;
- every retained `clearsThrough` has canonical map shape, unique supported fingerprint coordinates, and uint64 values;
- retained same-author/key/generation validation vectors are componentwise monotone when comparable evidence is present;
- `localJournalClock` equals the local fingerprint coverage coordinate and locally authored entries do not exceed it; foreign retained sequences may exceed it under lazy raising;
- every retained entry has a self-contained `nodeName` and `bindings` address from which its NodeKey is derived;
- journal coverage dominates every retained entry sequence; and
- the local coverage coordinate equals the durable local clock. Coordinate gaps are allowed.

Canonical compacted form, surviving same-author historical monotonicity
evidence, and complete diagnosis of unsupported history are not restoration
preconditions. Defensive corruption checks remain optional at the supported-
state boundary. Canonical form is storage normalization, not validity:
canonical does not imply valid, and non-canonical does not imply invalid. A
supported uncompacted journal remains supported state; manually forged or
corrupted history remains unsupported even if it happens to be canonical.

Restoration resumes previously emitted durable state and MUST NOT classify the restored graph as an empty-to-restored transition. Durable encoded cursors preserve their exact vector coordinates across restart and remain portable without adoption or coverage rejection when every fingerprint coordinate denotes the same durable writer history in the origin and receiver contexts.

The supported source is the host's current synchronized state, not an arbitrary historical checkpoint. Restoring an older checkpoint under the same author/clock is unsupported unless a future recovery protocol supplies anti-rollback state or assigns a new durable database fingerprint. Any failure to query, obtain, validate, or install the expected current state is fatal; startup does not silently fall back to an empty database.

### 4.3 Creating a new host state

If the current hostname has no synchronized branch, startup uses the supported fresh-host lifecycle. It provisions the host's probabilistically chosen durable `DatabaseFingerprint` together with persistent journal allocator and local coverage coordinate before writable open, initializes local synchronization state, and runs normal synchronization from an empty graph. Fingerprint collisions are possible and creation makes no uniqueness guarantee. This establishes the host's own synchronization history and then merges compatible hosts' immutable journal entries under ordinary synchronization rules without adopting their database identities.

The empty database is a legitimate initial state. On the first migration gate, absence of a stored database version means **fresh database**, and the running version is recorded without running a data migration.

This fallback is not a general-purpose import from an arbitrary host. Other host states are accepted only through normal synchronization, including its exact version-compatibility requirement. In particular, an unversioned fresh database is not implicitly treated as compatible with a versioned remote host.

### 4.4 Creation postconditions

After successful creation and startup:

- a local live database exists and is openable;
- its active logical state is structurally loadable;
- it records the database version expected by the running application;
- its synchronization identity and history were established by Volodyslav; and
- the graph interface is initialized from that state.

Copying database files or directories is not an alternative creation path and does not establish these postconditions.

## 5. Ordinary database evolution

After startup, database state evolves through the incremental graph and its domain-facing interface. Supported mutations include changes to source values, invalidation, recomputation, and deletion through Volodyslav APIs. Callers do not directly edit persisted representations.

Ordinary evolution preserves these lifecycle invariants:

1. **Version ownership.** Writes target the active state associated with the running database version. A write path that discovers a different stored version fails rather than writing across that boundary.
2. **Durable-before-visible commit.** A successful transaction persists its settled state before corresponding volatile state is treated as committed.
3. **Coherent graph state.** Values, dependency relationships, freshness, and associated derived metadata describe one settled graph state after a successful transaction.
4. **Atomic transaction boundary.** Other operations observe the state before or after a transaction's finalization, not a deliberately exposed partial finalization.
5. **Exclusive maintenance boundary.** Migration, synchronization, reset, and active-state cutover wait for ordinary graph activity and prevent new ordinary activity until maintenance completes.
6. **Schema-mediated access.** Runtime operations use the graph schema and database abstraction to address and evolve state. They do not infer a new schema from arbitrary persisted contents.

These invariants are obligations of supported write paths. If a supported operation reports success while violating one of them, that is a lifecycle bug.

## 6. Migration

Migration is the supported transition between database versions. It is part of startup and of reopening after synchronization; it is not a separate user-facing repair or import tool.

### 6.1 Migration decision

The running application supplies the target database version and current graph schema. After opening the active state:

- if no version is recorded, the database is treated as fresh and is marked current;
- if the stored version equals the running version, migration is a no-op; and
- if the versions differ, migration is required before the graph interface can be initialized.

Version inequality requests migration; it does not by itself prove that migration can succeed. The migration procedure must still establish all migration preconditions.

### 6.2 Migration procedure and invariants

A migration examines the materialized state from the previous version and makes an explicit disposition for it under the new schema. Depending on the migration policy, state may be retained, transformed, invalidated for recomputation, created, or removed.

The migration framework enforces lifecycle-level compatibility conditions, including:

- every materialized part of the previous graph must receive a complete and non-conflicting decision;
- retained or transformed state must be representable by the new schema;
- dependency changes must remain coherent, including deletion propagation and fan-in constraints; and
- the target state must carry the running database version and the metadata required to reopen it.

Migration constructs the target state away from the currently active state. It makes that target active only after validation, transformation, durable writes, and flushing succeed. Therefore, a failure before cutover leaves the previously active state selected and available for a later retry or diagnosis.

Migration checkpointing records the state around the migration as part of the controlled lifecycle. Checkpoint publication is operational bookkeeping around the database transition, not an independent restore API. A failure reported after the database cutover may mean that the database transition committed but its post-migration checkpoint did not; callers and operators must not assume that every reported migration failure implies an unchanged database.

### 6.3 Migration failures

The following are migration precondition or execution failures, not corruption by definition:

- the migration policy does not decide all previous materialized state;
- decisions conflict or violate dependency constraints;
- previous state cannot be represented under the new schema;
- a durable write or cutover fails; or
- required checkpoint operations fail.

They become evidence of corruption only if the failure shows that the input was outside the states producible by supported earlier transitions.

## 7. Synchronization

Synchronization exchanges database state among host-specific histories in the configured repository. The repository is a transport and checkpoint boundary; synchronization semantics are defined by Volodyslav's structured database merge, not by treating database state as arbitrary user-editable files.

### 7.1 Synchronization preconditions

Normal synchronization requires:

- a configured, reachable synchronization repository;
- a valid hostname for the local host and recognizable host identities for participating branches;
- exclusive maintenance access to the database;
- an openable local state that can be checkpointed;
- remote snapshots that can be parsed into staging state; and
- exact database-version compatibility for every host state that is merged.

The in-process database is closed before synchronization changes its durable state. The operation is serialized against graph activity so checkpointing and merging see stable transition boundaries.

### 7.2 Normal synchronization flow

Normal synchronization performs these lifecycle steps:

1. Open a stable local database state if necessary.
2. Render and checkpoint the local state, then synchronize the local host's branch with the repository.
3. Fetch the participating host branches.
4. For each other recognized host, load its snapshot into isolated staging state.
5. Check version and structural merge preconditions.
6. Only after those checks, union journals and compute and commit a graph-aware merge into a non-active target state.
7. Cut over to the merged state only when the merge produced changes and completed successfully.
8. Remove the host's staging state.
9. Reopen the application database and run the migration gate before exposing it again.

The merge resolves state according to graph timestamps and dependency semantics, not textual repository merge rules. Locally newer state is retained, remotely newer compatible state may be taken, and affected derived state may be invalidated so that it is recomputed from the merged dependencies. A successful merge preserves graph coherence and does not make a partially constructed target active.

Checkpointing serializes the complete stable supported state. Canonical compaction is optional, so both journal history may be uncompacted. It preserves immutable coordinates, the allocator, journal coverage, and durable fingerprint exactly. Restoration neither compacts nor renumbers and durable cursors retain meaning.

### 7.3 Per-host failure behavior

Host branches are processed independently. A failure for one host is recorded, staging cleanup is attempted, and synchronization continues with the remaining hosts. Successful earlier or later host merges remain committed. After all hosts have been attempted, Volodyslav reports an aggregate synchronization failure if any host failed.

Synchronization is therefore not globally atomic across all remote hosts. Its postcondition on aggregate failure may include successful merges from compatible hosts. Reviewers must not classify this documented partial-success behavior as corruption.

After an initiated synchronization, Volodyslav attempts to reopen the local database and rerun the migration gate even if synchronization itself failed. If both synchronization and reopening fail, both failures are relevant. A synchronization error does not justify leaving the application interface attached to a closed database.

### 7.4 Existing-live observed semantic reset

For stable validated snapshots R0,S0 and transaction time τ, reset constructs the complete target off-line, then atomically installs it. Target SemanticGraph equals S0 in NodeKey presence, ComputedValue, fresh/stale-soft/stale-hard class, and reusable proof relation semantically relowered to receiver NodeIdentifiers. Surviving keys retain receiver identifiers; absent→present allocates fresh; present→absent permanently retires. No intermediate state is visible. Reset does not import source journal or journalCoverage.

Value classification is receiver-relative and exact:

* absent→present: generation(add)+mandatory initial freshness, with value modifiedAt and generation time τ;
* present→absent: delete at τ;
* present X→present Y unequal by `isEqual`: ordinary edit scoped to surviving receiver generation, edit time/modifiedAt τ; if the target is soft/hard, a new matching invalidate is authored after that edit and pre-edit negative authority is not reused;
* present A→present A: no generation/add/edit and preserve receiver modifiedAt;
* freshness/proof-only changes preserve modifiedAt.

A second identical reset does not refresh timestamps.

### Causal absorption planning

Reset reasons against the hypothetical journal/coverage union of both consumed snapshots without installing source history. Source-only journal entries are evidence for receiver authoring, never installed receiver authority. Reset-authored `clearsThrough` may use either validated consumed snapshot as closed-prefix evidence. The reset transaction observation watermark is the maximum sequence in receiver retained entries/coverage/local clock and validated source retained entries/coverage. Before its first local event it raises allocation above that watermark, then allocates monotonically. This observation does not install any source journalCoverage coordinate; only the receiver coordinate advances when reset authors.

For every reset-touched NodeKey, reset retains one compact `ResetLineage(consumedThrough,correspondence)` on receiver authority. A present target stores it on the receiver freshness assertion anchored to the retained value origin; present-to-absent stores it on the real public delete. Absent-to-absent authors an internal reset-observation anchored to the existing delete or to explicit null absence when the receiver has no presence entry, with no public action. A source null observation itself makes the key reset-touched even without a source add/delete. The null anchor remains effective after delayed consumed source entries are unioned: entries through `consumedThrough` cannot manufacture presence, while post-cutoff generations/deletes participate in ordinary presence order. `consumedThrough` componentwise carries every prior receiver-anchor lineage vector, every retained source-anchor lineage vector, validated source coverage, and every genuine retained public event coordinate for this NodeKey. This transfers causal absorption only—exact semantic correspondence remains independently scoped and is never widened from the vector. Thus reset-of-reset consumes the source snapshot's durable causal meaning without importing its journal or journalCoverage.

Each lineage carrier is also an individual fallback assertion. Same-author assertions on the same tagged receiver anchor form a writer-local sequence chain: a later assertion replaces an earlier assertion while componentwise carrying its absorption vector. It still omits the earlier carrier coordinate, so an unchanged reset does not chase its own local clock. Across authors or anchors, assertion N supersedes assertion O only when N's own `consumedThrough` covers O's actual anchor-presence coordinate (when non-null) and O's immutable carrier coordinate. Joined per-anchor vectors summarize absorption but do not create cross-anchor observation. Thus `A1 -> B1 -> A2` selects A2 only because A2 actually observed B1, regardless of B1 having observed historical A1. A currently inapplicable maximal assertion remains future-relevant because a later raw displacement inside its cut can make it applicable again. Compaction retains the maximal assertion antichain and the per-author coordinates of its anchors. On an unchanged repeat, the bookkeeping exclusion set is exactly the reset-lineage carriers whose `lineage_anchor` equals the receiver's current tagged anchor plus that present value-origin/delete anchor event itself; their vectors remain knowledge, but their authoring coordinates are not recursively chased. Every carrier from another historical anchor is genuine observed history and advances the new prefix. Reset does not install those coordinates in receiver journalCoverage, and source causal vectors never imply or transitively copy exact semantic correspondence.

For each author A, an event at or below `consumedThrough[A]` was observed and is absorbed; a same-lineage scoped event, delete, or rematerialization above it remains live. Missing A means zero. Event authorship, not the physical carrier or reset-source container, selects the coordinate. Concurrent observations on the same receiver anchor join their vectors componentwise; JournalEntryId order alone proves no observation. Exact semantic correspondences are retained separately as the bounded set of source generation/origin pairs actually compared `isEqual` with that receiver anchor. The causal vector never implies correspondence for arbitrary origins beneath it.

For a key/generation, the **consumed absorption prefix** contains the validated source coverage coordinates, every applicable receiver/source invalidate coordinate that the target must clear, and every coordinate already carried by an applicable receiver validation. For a fresh target, applicable invalidates means both modes. For a soft target, it means hard invalidates; the intended receiver-retained soft assertion remains deliberately above/outside the clearing validation. Receiver coverage growth caused solely by a reset assertion is not recursively added to this prefix. Consequently an unchanged repeated reset tests the same semantic obligation rather than chasing its own clock.

* Fresh target: retain an existing validation only when that validation is present in the receiver journal that will be installed and its `clearsThrough` componentwise dominates the consumed absorption prefix. Otherwise author one receiver validation with that property. A source-only validation cannot satisfy this test, even when it covers every currently retained frontier member.
* Hard target: ensure an applicable hard invalidate is uncleared and remove reusable incoming proofs. If reset edited the value, always author a new receiver hard invalidate after the edit; otherwise an already retained applicable hard barrier may represent the decision. Source-only authority is never sufficient retained authority.
* Soft target: ensure a receiver-retained validation componentwise dominates the hard-mode consumed absorption prefix, then ensure one receiver-retained soft invalidate remains uncovered. If reset edited the value, always author a new receiver soft invalidate after the edit; otherwise an existing qualifying receiver soft assertion may be retained. A source-only soft invalidate cannot satisfy the second condition. A hard→soft stabilization may atomically author the clearing validation and then the soft invalidate.

Separate old partial validations are not combined; the reset validation is one new assertion justified by its actual joint observation. Unseen/concurrent history above the consumed prefixes remains live. A delayed compacted event within a claimed prefix is cleared. Presence and value reconciliation interpret the per-author lineage vector exactly as above. This rule applies to present and absent targets and when reset preserved an already-present receiver generation; no author or carrier must first receive the receiver anchor.

Idempotence compares the hypothetical combined frontier, not raw coverage growth. If an existing assertion already absorbs unchanged S0 and graph target matches, reset authors nothing and leaves graph, journal, receiver coverage, local clock, identifiers, and timestamps byte-for-byte unchanged.

**Observed Reset Absorption Theorem.** Let `R1=resetτ(R0,S0)` and `R2=sync(R1,S0)` with unchanged S0. R1 matches S0 SemanticGraph; changed/created values use τ and equal values preserve receiver modifiedAt; reset creates no equal-value generation; R2 has the same SemanticGraph and authors no receiver event, though it may import S0 journal/coverage. Events outside consumed prefixes remain governed by ordinary synchronization.

**No Provenance-Only Hardening.** Existing valid proofs transport across equal semantic input/output values under the extensional computor contract, even when revision/provenance IDs differ.

A source value with modifiedAt greater than τ contradicts the supported synchronized-clock premise for an already observed value-changing event. Reset rejects/classifies that snapshot as unsupported rather than silently backdating or repairing it.

### 7.5 Counter continuity during self-restoration

A writer MUST never resume authoritative mutation with a local action sequence
at or below a sequence it previously authored with the same `DatabaseFingerprint`.

```text
A previously published:
    JournalEntry(author=A, sequence=10, nodeName=N, bindings=B, action=edit, generation=G)

A loses its live database.

A restores its own synchronized snapshot:
    JournalEntry(author=A, sequence=10, nodeName=N, bindings=B, action=edit, generation=G)

A edits K:
    localJournalClock advances to 11
    JournalEntry(author=A, sequence=11, nodeName=N, bindings=B, action=edit, generation=G)

B previously observed 10:
    journal merge retains 11 over covered edit 10
    B imports the unchanged precise journal entry
```

The rollback below is invalid because sequence reuse makes the new edit conflict with immutable history:

```text
restore OA at sequence 0
emit sequence 1
peer already has sequence 10

join chooses 10
new edit is invisible
```


## 8. Version compatibility

A database version identifies the interpretation of synchronized graph state, not merely the application executable that wrote a file. Version checks protect boundaries where two pieces of state would otherwise be interpreted together.

### 8.1 Local open and migration

A local stored version that differs from the running version enters the migration transition. The running application must not use the old state as current before migration succeeds.

### 8.2 Synchronization boundary

Before merging a staged host, Volodyslav compares the local and remote global database versions. In the current rendered synchronization representation, this is the value represented at `r/global/version` for each host snapshot. If the values differ—including one being absent while the other is present—the host merge fails.

This exact-match rule is a lifecycle invariant. Hosts with different global database versions may assign different meaning, schema, or dependency behavior to synchronized state. Merging across that boundary is not a supported transition. A supported migration or upgrade path must first establish compatible versions; synchronization is not itself a cross-version migration mechanism.

A version mismatch is an **incompatible-version situation**, not automatically corruption. It should fail clearly for the affected host and leave non-active merge work unselected.

### 8.3 Version checks on writes

Ordinary write paths also enforce the running version when they first write to a logical target. This catches incorrect use of a state prepared for another version. It is a guard against lifecycle implementation errors, not a promise to validate arbitrary persistence damage.

## 9. Trust and threat model

Volodyslav assumes participating hosts and the local client are **non-adversarial**. A host may be offline, stale, interrupted, temporarily unreachable, or running an incompatible version. It is not assumed to intentionally forge a hostname, craft malicious graph state, lie about timestamps, or attack resource consumption.

Consequences of this model include:

- synchronization checks compatibility and structural preconditions for correctness, not authenticity or authorization;
- host names, published state, and merge metadata are trusted once they pass the checks required by the lifecycle operation;
- conflict resolution assumes timestamps and graph state were produced honestly by Volodyslav;
- there is no requirement for Byzantine fault tolerance, malicious-peer isolation, cryptographic provenance, or recovery from intentionally crafted database contents; and
- a failure caused by an outdated or interrupted non-adversarial host should be reported and isolated to that host where the current synchronization design permits it.

Non-adversarial does not mean perfectly reliable. The lifecycle must still handle ordinary operational failures without deliberately exposing partially committed state, and must fail when compatibility preconditions are not met.

## 10. Unsupported operations

The following are outside the supported database lifecycle model:

- copying a live database directory between installations;
- manually replacing, restoring, or combining database directories;
- editing a rendered synchronization snapshot;
- constructing or modifying host branches outside Volodyslav;
- changing database files while Volodyslav is running;
- bypassing the startup migration gate;
- forcing synchronization between versions that fail compatibility checks; and
- treating checkpoint history as a user-facing backup/restore interface.

Such actions may happen at the operating-system level, but Volodyslav does not promise to interpret, validate, preserve, migrate, synchronize, or recover the resulting state. If file-level recovery or import becomes a product requirement, it must be introduced as a new Volodyslav-controlled transition with explicit preconditions and postconditions.

## 11. Corruption model

For this specification, **corruption** means either:

1. a database state that was not produced by a supported Volodyslav lifecycle transition; or
2. a state produced after a required lifecycle precondition was violated.

This definition is intentionally independent of current storage artifacts. Corruption is not a catalog of malformed keys, missing files, or inconsistent internal indexes.

Volodyslav may detect some corrupted states while opening, migrating, resetting, or synchronizing and fail loudly. Examples at the lifecycle level include inability to identify the active logical state, inability to load metadata required by a non-fresh state, a structurally invalid graph, or state that cannot satisfy a transition's declared invariants. These checks improve locality and diagnostics.

Volodyslav is not required to:

- detect every state outside the model;
- assign meaning to arbitrary damaged state;
- infer which unsupported filesystem manipulation occurred;
- repair corruption automatically; or
- preserve corrupted input while attempting a supported transition.

A state is not corruption merely because an operation refuses it. Exact version mismatch, migration incompatibility, unavailable remotes, and per-host synchronization failures each have their own failure classification when their inputs were otherwise produced by supported transitions.

## 12. Validation assumptions

Volodyslav validates at lifecycle boundaries where validation establishes a guarantee needed by the next transition. Examples include:

- environment and hostname validation before bootstrap or synchronization;
- structural validation needed to open the active state;
- migration completeness and new-schema compatibility;
- synchronized host version equality and merge preconditions;
- graph acyclicity and metadata required to construct a coherent merged target; and
- persistence and cutover success before exposing a new active state.

Within those boundaries, Volodyslav may trust persistent state produced by supported Volodyslav transitions. It is not required to revalidate every internal consequence on every read or to defend against arbitrary storage tampering.

Validation remains appropriate when it provides:

- a compatibility decision;
- a migration precondition;
- a synchronization precondition;
- a clear, local diagnostic for an invariant violation;
- protection against an implementation bug crossing a version or cutover boundary; or
- test evidence that a supported transition preserves its postconditions.

Adding validation does not expand the supported threat model by itself. Conversely, omitting exhaustive validation of unsupported states is not a lifecycle bug unless the omitted check is required to keep a supported transition from violating its own invariants.

## 13. Failure classification for reviewers

When reviewing a failure, classify it by the transition being attempted:

| Classification | Meaning | Expected response |
| --- | --- | --- |
| Supported-transition bug | Valid preconditions were met, but the transition violated a lifecycle invariant or reported success without its postconditions. | Fix the implementation and add transition-level regression coverage. |
| Incompatible version | Independently valid states have unequal global database versions at a synchronization boundary. | Fail the affected merge; migrate or upgrade through a supported path. |
| Migration precondition failure | Previous state is usable, but the migration policy cannot completely and coherently represent it under the target schema. | Fail migration without selecting an incomplete target; revise the migration or its declared support. |
| Synchronization precondition failure | Repository, host snapshot, version, graph, or operational prerequisites for sync are not satisfied. | Fail or isolate the affected host according to sync semantics; do not force a merge. |
| Corruption | The state is outside the closure of supported transitions, or a transition precondition was bypassed. | Fail loudly where detected; no general interpretation or recovery is promised. |
| Unsupported manipulation | State was produced by direct filesystem, snapshot, or repository editing rather than a Volodyslav transition. | Treat it as outside the model; define a controlled import/recovery transition before supporting it. |

## 14. Implementation consequences

Implementations and future changes MUST preserve the following lifecycle properties:

1. Startup MUST distinguish existing local state from absent local state before choosing bootstrap behavior.
2. Discovering expected synchronized state for the current host MUST NOT silently degrade to fresh creation when restoration fails.
3. The graph interface MUST NOT become initialized before the database is open and current, including successful completion of any required migration.
4. Version-changing local use MUST go through migration; version-different peer state MUST NOT be merged by normal synchronization.
5. Normal synchronization MUST checkpoint stable local state and perform structured database merge rather than exposing textual repository merge as database semantics.
6. Migration and synchronization MUST construct replacement state away from the selected active state and cut over only after their state-building preconditions succeed.
7. Maintenance transitions MUST be exclusive with ordinary graph activity.
8. Per-host synchronization failures MAY coexist with successful merges from other hosts, but the aggregate result MUST report the failures.
9. Reopening after synchronization or reset MUST pass through the migration gate before database-backed services resume.
10. Tests and diagnostics SHOULD distinguish incompatibility, failed preconditions, corruption, and unsupported manipulation rather than using those terms interchangeably.
11. New recovery, import, or restore behavior MUST be implemented as a Volodyslav-controlled lifecycle transition. Documentation alone MUST NOT redefine raw file manipulation as supported.
12. Storage refactors MAY change physical artifacts without changing this specification, provided these lifecycle preconditions, transitions, and postconditions remain true.
13. Existing-live reset MUST retain the receiver journal and coverage, MUST NOT import source journal or coverage, and may author only precise receiver-local semantic transitions and causal stabilization assertions required by observed reset.
14. Absent-state self-restoration MUST restore the same host's current published clock and continue its counters without empty-graph classification.
15. Raw cross-host copying of a live database remains unsupported; copied writer metadata does not establish ownership.

## 15. Known boundaries

The current lifecycle does not define:

- arbitrary corruption repair;
- a user-facing database backup or import command;
- cross-version synchronization;
- malicious-host detection or containment;
- global all-host atomicity for synchronization; or
- automatic rollback of a database transition whose state cutover succeeded but whose subsequent checkpoint bookkeeping failed.

These are deliberate boundaries of the present model, not implied future requirements. Any proposal to add one should specify a new supported transition and how it composes with startup, migration, synchronization, and version compatibility.
