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

This document has two parts. **Part I** governs the database as a materialized graph with
version-gated migration, and is the canonical lifecycle specification for it. **Part II**
governs the same database under Journal 3, where the journal is the semantic authority and the
graph sublevels are a projection of it. Where Part I and Part II describe the same transition,
Part II is the more specific rule and governs; Part I's non-Journal rules continue to apply
where Part II does not speak to them.

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
7. **Canonical bootstrap**: a supported pre-Journal replica is offered to the configured cohort and the selected canonical cut is installed and the replica pointer moved. Part II §23 owns this transition.
8. **Projection rebuild**: derived graph and index state is reconstructed from valid retained Journal history. Part II §26 owns this transition.

A successful startup ends in the **Current** state before the database-backed application interface is exposed as initialized. Failure to satisfy a transition's preconditions aborts that transition; Volodyslav MUST NOT silently reinterpret an incompatible or unsupported state as a fresh database.

## 3. Startup flow

`volodyslav start` initializes the server and its required environment, system capabilities, and application services. Database initialization is a required startup dependency. If database initialization fails, application initialization does not complete successfully.

Database startup follows this sequence:

1. **Validate operating context.** Required environment configuration is read before normal database use. This includes a working location, synchronization repository, and a valid local hostname. Required external capabilities, including Git, must be available.
2. **Determine whether local live state exists.** Existence is a bootstrap decision only. Existing state is opened; it is not overwritten by a remote snapshot merely because startup is occurring.
3. **Bootstrap when absent.** Volodyslav selects one of the controlled creation paths described in [Database creation](#4-database-creation).
4. **Open the local database.** The database implementation opens the durable state and establishes the active logical state. Required structural metadata must be valid enough to identify and load that state.
5. **Run the migration gate.** A fresh database is marked with the running database version. A database already at that version proceeds unchanged. A database at a different version must complete migration.
6. **Run the canonical-bootstrap gate.** Part II §23 governs this step. A replica that is fresh, empty, or already retains Journal records is left alone. A supported pre-Journal replica has a canonical cut installed and its replica pointer moved, or startup fails: with `JournalPublicationError` when no cohort source is configured, and with `UnresolvedCanonicalBootstrapError` when the cohort outcome is unresolved. A `JournalError` from the source read, the arbitration, or either consumer is propagated by name.
7. **Construct and expose the incremental graph.** The database-backed graph interface becomes initialized only after opening, migration, and canonical bootstrap have succeeded.

Startup does **not** perform an ordinary synchronization when local live state already exists. Synchronization is a separate controlled operation. This distinction prevents routine startup from unexpectedly replacing or merging local state and makes migration and canonical bootstrap the only startup transitions that change which state is selected.

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

Part II §19 specifies the absent-state decision as an `InstallationRecoverySource` query, and
§19.4 records that the branch does not yet implement one. The steps below are what startup
actually does today.

### 4.2 Restoring this host's synchronized state

When local live state is absent, Volodyslav first asks whether the synchronization repository contains state previously published for the current hostname.

If it does, startup uses the controlled reset-to-host path to restore that snapshot into a newly opened local database. The imported state is committed through the database's normal cutover mechanism, then the database is reopened and passed through the migration gate. Thus a host can recover its own synchronized state and then migrate it to the running version.

Any failure to query, obtain, parse, or install that state is fatal to bootstrap. Volodyslav does not silently fall back to an empty database after discovering that the host is supposed to have synchronized state.

### 4.3 Creating a new host state

If the current hostname has no synchronized branch, startup initializes the local synchronization working state and runs normal synchronization from an empty local database. This establishes the host's synchronization history and then considers other host branches under the ordinary synchronization rules.

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
6. Compute and commit a graph-aware merge into a non-active target state.
7. Cut over to the merged state only when the merge produced changes and completed successfully.
8. Remove the host's staging state.
9. Reopen the application database and run the migration gate before exposing it again.

The merge resolves state according to graph timestamps and dependency semantics, not textual repository merge rules. Locally newer state is retained, remotely newer compatible state may be taken, and affected derived state may be invalidated so that it is recomputed from the merged dependencies. A successful merge preserves graph coherence and does not make a partially constructed target active.

### 7.3 Per-host failure behavior

Host branches are processed independently. A failure for one host is recorded, staging cleanup is attempted, and synchronization continues with the remaining hosts. Successful earlier or later host merges remain committed. After all hosts have been attempted, Volodyslav reports an aggregate synchronization failure if any host failed.

Synchronization is therefore not globally atomic across all remote hosts. Its postcondition on aggregate failure may include successful merges from compatible hosts. Reviewers must not classify this documented partial-success behavior as corruption.

After an initiated synchronization, Volodyslav attempts to reopen the local database and rerun the migration gate even if synchronization itself failed. If both synchronization and reopening fail, both failures are relevant. A synchronization error does not justify leaving the application interface attached to a closed database.

### 7.4 Controlled reset

A reset-to-host synchronization selects a host snapshot and installs it through a non-active target state followed by cutover. It is used during restoration and may also be invoked through a Volodyslav-controlled synchronization path.

Reset is intentionally different from normal merge: it selects the snapshot as the logical source rather than combining it node by node with the current state. The selected snapshot must still be structurally importable and must pass required database identity checks. When reset is applied to an already-existing local database, implementation-defined host-local state that must remain local is preserved by the reset path. When reset is used during absent-local-state bootstrap, there is no previous local database identity to preserve; the selected synchronized host snapshot is installed according to the bootstrap protocol.

After reset, the database is reopened through the migration gate. A reset snapshot may therefore be older than the running application if the supported migration can bring it forward. This does not weaken the normal synchronization rule that peer-to-peer merging requires matching versions before merge.

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
9a. A supported pre-Journal replica MUST pass through the canonical-bootstrap gate in Part II §23 before graph-backed services resume, and an unresolved publication outcome MUST leave the pre-Journal database selected.
10. Tests and diagnostics SHOULD distinguish incompatibility, failed preconditions, corruption, and unsupported manipulation rather than using those terms interchangeably.
11. New recovery, import, or restore behavior MUST be implemented as a Volodyslav-controlled lifecycle transition. Documentation alone MUST NOT redefine raw file manipulation as supported.
12. Storage refactors MAY change physical artifacts without changing this specification, provided these lifecycle preconditions, transitions, and postconditions remain true.

## 15. Known boundaries

The current lifecycle does not define:

- arbitrary corruption repair;
- a user-facing database backup or import command;
- cross-version synchronization;
- malicious-host detection or containment;
- global all-host atomicity for synchronization;
- automatic rollback of a database transition whose state cutover succeeded but whose subsequent checkpoint bookkeeping failed;
- the `InstallationRecoverySource` absent-state decision of Part II §19, which is stated as a requirement and is not implemented (Part II §19.4); or
- supply of a persisted `stagedCandidate` to the canonical-bootstrap arbitration on retry (Part II §23.2), for which no persisted candidate store exists.

These are deliberate boundaries of the present model, not implied future requirements. Any proposal to add one should specify a new supported transition and how it composes with startup, migration, synchronization, and version compatibility.

---

# Part II — Journal 3 lifecycle

## 16. Journal 3 scope and the central law

Parts I–III above govern the database as a materialized graph with version-gated migration.
Part II governs it under Journal 3, where the journal is the semantic authority and the graph
sublevels are a materialized projection of it. The central law is:

```text
persisted materialized graph == project(retained journal)
```

The active replica has one current persisted representation selected by `global/version`.
Journal records do not carry independent record versions.

This is a lifecycle specification, not a transport specification. It requires stable Journal
snapshots and controlled local publication; it does not prescribe a Git layout, a hosted
backend, or another transport protocol.

`incremental-graph-journal.md` owns Journal semantics. This part owns only how those
semantics meet startup, restoration, bootstrap, migration, synchronization, reset, and
rebuild.

### 16.1 What Part II does not yet guarantee

Two rules below are requirements the branch does not yet implement. They are stated here as
requirements and are marked at the point they bite, rather than being deleted or softened:

1. **Absent-state restoration.** §19 specifies an `InstallationRecoverySource` and
   `ContinuationSafeSnapshot`. No `InstallationRecoverySource` and no
   `ContinuationSafeSnapshot` exist in `backend/src` on this branch. What startup actually
   does for a completely absent local database is the reset-to-hostname probe and the
   normal-sync fallback in `docs/database-boot-sequence.md` §7.1. §19.1 records the gap.
2. **§6 retry discipline at startup.** The arbitration accepts a `stagedCandidate` so that a
   retry republishes that exact candidate. Nothing persists a staged candidate across a
   restart, so a crashed publication attempt re-stages from the persisted pre-Journal state
   on the next startup. Staging is a pure function of that state, so the re-staged candidate
   is byte-identical and the requirement is satisfied by construction — but no caller yet
   supplies `stagedCandidate`, and the "supply it when the outcome is unknown" path is not
   exercised. §23.2 records the gap.

## 17. Journal 3 lifecycle states

A local installation is in one of these lifecycle states:

- **Absent** — no supported local database/writer identity is present locally, including after
  complete loss of the local database;
- **Legacy/migratable** — a structurally valid supported pre-Journal database exists;
- **Current** — active database version/schema match the running application and the graph
  equals Journal replay;
- **Incompatible for an operation** — independently valid state cannot participate in the
  requested sync/reset/migration/bootstrap boundary; or
- **Corrupted/unsupported** — required invariants fail, state was produced outside supported
  transitions, or local persistent state has been partially deleted, rolled back, mixed, or
  externally modified.

Supported transitions are:

1. absent-state restoration of this installation's synchronized history;
2. fresh creation when no such history exists;
3. open;
4. ordinary graph evolution;
5. pre-Journal canonical bootstrap;
6. Journal-aware migration;
7. synchronization;
8. controlled reset; and
9. projection rebuild from valid authoritative Journal history.

A successful startup reaches **Current** before graph-backed APIs are exposed.

A process or power crash during a supported transition does not create a new arbitrary
lifecycle state. The transition's atomicity and crash rules ensure that any state later
exposed for supported use is itself one of the valid states permitted by that transition. If
storage damage instead produces a partial or rolled-back database, that state is
corrupted/unsupported rather than a new recovery case.

## 18. Journal 3 startup flow

Startup performs:

1. validate the required operating context;
2. determine whether supported local database state is completely absent or exists;
3. if local state is absent, run the absent-state decision in §19;
4. otherwise open the existing state sufficiently to read version and current committed-pair
   metadata and validate the lifecycle boundary;
5. run the migration and canonical-bootstrap gate (§23);
6. for an already-current supported database, perform only the bounded routine-open checks in
   §21; run full replay or rebuild only as part of an explicit transition that requires it;
   and
7. expose IncrementalGraph APIs.

Startup never silently reinterprets malformed, partially missing, rolled-back, incompatible,
or otherwise unsupported existing state as absence or as a fresh database.

Routine startup of an already-current local database does not imply ordinary multi-source
synchronization unless outer application policy explicitly requests it.

Maintenance transitions are exclusive with ordinary graph activity at their
publication/cutover boundary.

## 19. Absent-state decision

This section applies only when the local IncrementalGraph database is completely absent. An
existing but damaged, truncated, or older local database does not enter this path.

The absent-state decision happens **before generating a new `DatabaseFingerprint`**.

The outer lifecycle obtains a transport-neutral `InstallationRecoverySource` capable of
answering whether recoverable synchronized state exists for **this installation**. The source
is an abstraction: an implementation may construct it from one storage location, several
locations, a Git-backed transport, a hosted service, files, or another persistence topology.

The IncrementalGraph database does not persist a hostname, Git branch, repository locator, or
other transport identity for this source. Outer transport and lifecycle code may use
deployment configuration such as a hostname to construct or locate the source, but those
locators stay outside the persisted database and outside the `InstallationRecoverySource`
semantic interface, consistent with `$id-4373538486707762`.

### 19.1 Query the installation recovery source

Startup obtains exactly one of:

1. **source exists** — open or hold that source's stable database snapshot and restore it;
2. **source definitely does not exist** — fresh creation is allowed;
3. **query or read failed, or the result is indeterminate** — startup fails.

Failure to query or obtain known synchronized state MUST NOT fall back to fresh creation.

Fresh creation after `DefinitelyAbsent` assumes one live owner of this installation's
lifecycle and database. Two concurrent processes independently claiming the same
installation are outside the supported locking and lifecycle model and must be excluded by
outer installation ownership. This differs from canonical cohort bootstrap, where multiple
legitimate legacy installations may race and therefore require conditional publication
arbitration.

For writer A, call a held recovery snapshot with `frontier[A] = q` **continuation-safe at q**
if and only if, after restoring the completely absent installation from that snapshot, no
previously authored A record with sequence greater than q can later enter supported retained
history for writer A.

This is a property required only for absent-state restoration. It is not a mechanism for
repairing an existing local database that has gone backwards. Journal 3 does not prescribe one
mechanism for establishing the property. A recovery source may return
`Exists(ContinuationSafeSnapshot)` only when the guarantees of its supported backend model
imply that q is safe.

The supported backend model is allowed to rule out histories which cannot actually arise or
later re-enter under that backend. Recovery is not required to defend against every imaginable
storage topology. A backend may establish continuation safety because surviving writer history
can only propagate through a monotonic publication path; another backend could establish the
same property with a different protocol, replicated metadata, consensus, leases, or another
mechanism. None of those mechanisms is part of Journal semantics.

A record that existed only on the completely lost local storage need not count against
continuation safety when the supported backend model guarantees that no surviving copy can
later reintroduce it. Conversely, if a higher A record remains admissible under the supported
backend model and can later re-enter retained history, q is not continuation-safe.

This is also the recovery boundary required by `$id-2567281946348705`: a writer coordinate
beyond q may be reused only when its previous record cannot later coexist with, or be combined
with, the restored continuation in a supported execution.

Journal 3 does not require contacting or discovering every possible peer to establish
continuation safety, consistent with `$id-4719065396881648`.

#### The Git-backed transport as one way to satisfy §19.1

The Git-backed transport is one way to satisfy the abstract absent-restoration contract. This
paragraph is explanatory, not a required Journal topology.

In the supported flow, an installation renders and publishes its database through its
transport-managed remote branch before another installation can obtain that published writer
history through the same synchronization transport. The branch and location mapping is
transport configuration and is not stored in IncrementalGraph state. Under the normal
supported Git persistence model, successfully published branch history is not silently
rewound while still being treated as ordinary recoverable state.

Therefore a writer record which survives complete loss of the local database on some other
participating installation must already have passed through the remote publication path.
Local records written after the last successful publication but lost with the complete local
database may disappear permanently. Their writer sequence coordinates, and local
`NodeIdentifier` indices whose allocations are represented only by that discarded suffix, may
be reused after absent-state restoration.

If the remote repository itself is silently rolled back, loses previously published commits,
or is externally rewritten while surviving replicas still retain the removed writer records,
that violates the assumptions of this Git-backed recovery model. Such storage damage is
outside ordinary lifecycle recovery.

Continuation safety protects allocator identity as well as writer coordinates. The recoverable
writer prefix carries the `last_node_index` watermark that remains reserved. If a higher
allocation can later re-enter supported retained history, the older recovery point is not
safe; if the higher allocation existed only in the discarded suffix and cannot re-enter, its
index may be allocated again. This is the supported-history uniqueness rule of
`$id-4173361406347342`: reuse is allowed only when the two meanings cannot coexist in, or
later join, any supported retained state.

### 19.2 Receiver-less restore

Restoring an absent installation is conceptually:

```text
restoreAbsentFrom(source) -> Current-or-Migratable local database
```

It is not `synchronizeFrom()` or `resetTo()` because those operations require an
already-established writable receiver identity.

The held source snapshot supplies the continuing installation identity:

```text
localWriter = snapshot.localWriter
```

and MUST establish a continuation-safe head under §19.1 before this installation may author
another record under that writer.

Restore retains the source history and reconstructs:

- local writer head;
- local `last_node_index`, reconstructed from the retained writer prefix;
- authority high-water;
- materialized graph; and
- derived indexes and caches.

The reconstructed `last_node_index` may be lower than the destroyed database's final local
watermark when the missing suffix is continuation-safe to discard under §19.1. No new semantic
record is required merely to restore exact retained history.

The restored snapshot may be at an older supported Journal version. Startup then runs the
normal migration gate before exposing graph APIs.

### 19.3 Fresh creation only after definite absence

Only definite absence permits fresh creation. Fresh creation:

- generates one new durable `DatabaseFingerprint`;
- starts at local writer frontier zero;
- retains no foreign history;
- materializes an empty graph;
- initializes local `last_node_index` under the ordinary allocator contract; and
- records current version and schema metadata.

Thus:

```text
project(empty journal) = empty graph
```

### 19.4 This section is a requirement, not shipped behavior

Neither `InstallationRecoverySource` nor `ContinuationSafeSnapshot` exists in `backend/src`
on this branch, and `internalBootstrap` in
`backend/src/generators/interface/lifecycle.js` performs a `git ls-remote` probe for the
hostname branch followed by a `resetToHostname` restore or a normal-sync fallback instead.
That path is described in `docs/database-boot-sequence.md` §7.1 and §7.1.1.

The requirement in this section is retained unchanged. It becomes implementable when an
`InstallationRecoverySource` is supplied by deployment configuration and the two deletion
steps in `docs/database-boot-sequence.md` §7.1 are removed in the same change.

## 20. Existing local state never uses rollback recovery

An existing supported local database is authoritative for its own local-writer prefix. The
lifecycle does not contain a transition which repairs an existing database by importing a
missing suffix of its own writer after local rollback or partial data loss.

Therefore, if local writer A retains `A:1..p` but a synchronization or reset source contains
an agreeing `A:1..q` with `q > p`, this does not mean that A is a supported "behind writer"
awaiting recovery. It is evidence that one of the lifecycle assumptions has been violated, for
example partial local rollback or loss, unsupported cloning, or externally manipulated
persistence.

Such an operation must fail without authoring new A records or silently repairing the
receiver. `JournalWriterBehindError` may be used as the specific diagnostic for this
condition, but it denotes corrupted or unsupported lifecycle state rather than a recoverable
normal state.

Likewise, overlap disagreement for one writer coordinate is a writer fork and is unsupported.

More strongly, supported lifecycle closure implies **writer-prefix comparability** across any
states which may coexist or later combine: for each writer A, one retained A stream is a
prefix of the other, and every shared coordinate has the same immutable record. A partial
fork, meaning two such states agreeing through A:1..k and then retaining distinct A:k+1
records, is therefore impossible in supported state.

This follows from serialized append-only authoring, immutable foreign-record import,
continuation-safe absent restoration, canonical bootstrap arbitration, deterministic canonical
migration, and the exclusion of rollback, cloning, and external mutation. The accepted
fingerprint-collision tradeoff in `$id-9051842763146802` does not weaken this supported-state
rule: an actually observed same-fingerprint divergent pair is classified unsupported.

Ordinary sync and reset may rely on this lifecycle consequence and need not rescan unrelated
historical overlap merely to re-prove it. `incremental-graph-journal-theorems.md` Laws 8 and
8a state the derived proof obligations.

Two independently live installations intentionally authoring under one fingerprint are
unsupported.

The creator-resume rule in §23.4 is not an exception: it handles interruption of the one
controlled pre-Journal bootstrap transition before an active Journal database exists, and its
permitted states are explicitly defined by that transition.

## 21. Opening current Journal state

Opening a current Journal database selects one coherent atomically published pair:

```text
(retained journal, materialized projection)
```

The pair is already required, by the lifecycle transitions that produced it, to satisfy
contiguous writer streams, current-format decoding, causal and reference validity, replay
equivalence, and allocator and authority invariants. Routine open does not re-prove those
facts by scanning retained history.

Under `$id-7429043816351276`, routine Journal-specific open work for an already-current
supported database is `O(1 + G)`, where G is the current materialized graph plus
graph-bounded current-state metadata, and excludes retained history and history-proportional
Journal indexes. The bound is independent of retained Journal size H. Routine open checks
only current version and schema compatibility, constant-size or current-state metadata
identifying the selected atomically committed pair, local writer head, allocator watermark,
authority high-water, and current graph and index consistency work bounded by G.

Routine open MUST NOT perform a full Journal replay or complete historical well-formedness
scan solely to establish `graph == project(journal)`. That equality was established at the
successful publication, import, bootstrap, restore, migration, or reset cutover which selected
the active pair.

Known graph/Journal disagreement is not exposed as ordinary current state. Missing or
inconsistent committed-pair metadata causes startup failure or an explicit supported
maintenance or rebuild transition; explicit rebuild may replay and validate retained history
before exposure and is not subject to the routine-open history-independence bound.

A local Journal stream with a missing or truncated tail is not normalized into a shorter valid
history merely because some retained prefix appears internally usable. If supported metadata
or evidence shows that this installation previously authored a longer local prefix, the local
state is corrupted or unsupported under §20.

## 22. Ordinary evolution

Ordinary graph operations append replay-complete Journal history according to
`incremental-graph-journal-emission.md`.

For every successful committed semantic transition:

```text
project(journalAfter) == graphAfter
```

Graph and Journal publication is atomic. Failed operations consume no durable Journal
coordinate. A crash may expose only states permitted by the operation's transaction and
publication boundary; it does not make a partially committed Journal/projection pair a
supported state.

A successful operation which changes no persisted semantic state need not append a semantic
event merely because the API was invoked.

## 23. Migration and canonical-bootstrap gate

Detailed bootstrap and migration rules are normative in
`incremental-graph-journal-migrations.md`.

### 23.1 Gate decision

After reading the stored database version:

- matching current Journal version → no migration;
- supported older Journal version → resolve and execute the canonical Journal migration
  chain from that stored version to the running version, as defined by
  `incremental-graph-journal-migrations.md` §9b;
- older Journal version without a complete canonical chain to the running version → fail
  `JournalVersionCompatibilityError`;
- unsupported version → fail; and
- supported pre-Journal state → run the canonical-bootstrap decision below.

Absence of a stored version is treated as fresh only under genuine fresh-creation rules; it
does not erase structured existing state whose metadata is malformed or missing.

For every supported pre-Journal source version, the release identifies one expected **Journal
bootstrap target version and schema**.

That bootstrap transition is a **graph-semantic identity transition**. It may change
whole-database representation to introduce Journal storage, but before the canonical cut it
does not execute an ordinary graph migration. The persisted pre-Journal graph already supplies
the bootstrap semantic state: materialized `NodeKey`s, `NodeIdentifier`s, payloads, timestamps,
freshness, validity, `last_node_index`, and graph interpretation are preserved exactly.

Therefore a source and target pair which would require `MigrationStorage.create()`,
`invalidate()`, `delete()`, a schema-semantic rewrite, wall-clock output, fresh
allocator-dependent graph identity, randomness, or another semantic migration callback result
**before Journal identity exists** is not a supported automatic bootstrap path. Startup fails
`JournalVersionCompatibilityError` before authoring history.

Representation-only change is not a separate pre-Journal decision in this lifecycle. Actual
graph, schema, and representation migration runs only after Journal bootstrap, as an ordinary
Journal-aware migration using the canonical whole-history codec and semantic decisions such as
`keep`.

The running release is not required to retain legacy bootstrap support forever. An artifact
whose target version or schema is not exactly the release's expected bootstrap target fails
compatibility before history is authored.

### 23.2 Pre-Journal multi-host bootstrap

Replicas expected to synchronize after Journal introduction use one canonical semantic
bootstrap history as the shared `ValueId` basis for occurrences equal to the canonical cut.

Canonical-bootstrap query and publication arbitration is specified normatively in
`incremental-graph-journal-migrations.md` §4. The lifecycle consequences are:

- no local Journal cutover or ordinary Journal authoring occurs until that owned procedure has
  selected a durable canonical artifact;
- an unresolved publication outcome leaves the supported pre-Journal database selected and
  startup fails before graph APIs are exposed;
- retry re-queries and resolves the canonical artifact through the owned procedure before
  another publication attempt or cutover; and
- no Journal-3-controlled legacy mutation occurs while the publication outcome is unresolved.

Before create-resume and join interpretation require:

```text
canonical.databaseVersion   == expectedBootstrapTargetVersion
canonical.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

and require the semantic-identity bootstrap contract from §23.1. Incompatibility is
`JournalVersionCompatibilityError` before semantic history is authored.

#### Retry discipline is a requirement with no caller yet

`arbitrateCanonicalBootstrap` accepts `stagedCandidate` so that a retry republishes that exact
candidate rather than a freshly staged one. Nothing persists a staged candidate across a
restart, so a crashed publication attempt re-stages from the persisted pre-Journal state on
the next startup. Staging is a pure function of that state, so the re-staged candidate is
byte-identical and the requirement holds by construction, but no caller supplies
`stagedCandidate` today and the path is untested. This is an open gap, not a satisfied
behavior.

### 23.3 Where the gate runs

The gate is `runCanonicalBootstrapGate`, re-exported from
`backend/src/generators/incremental_graph/index.js` and called by
`internalCanonicalBootstrapGate` in `backend/src/generators/interface/lifecycle.js`. It runs
after the migration gate and before `createIncrementalGraph`.

It reads the active replica once through `readPreJournalSourceState`, and support is decided
once, there; nothing downstream re-derives it. Its outcomes are:

| outcome | behavior |
| --- | --- |
| `no-pre-journal-state` | the replica is fresh, empty, or already retains Journal records. Startup continues; the cohort is never contacted. |
| `canonical-bootstrapped` | the resolved cut was installed into the inactive replica and the replica pointer moved. |
| `unresolved-canonical-bootstrap` | nothing was written, the pre-Journal database is still the active persisted state, and startup fails with `UnresolvedCanonicalBootstrapError` before any graph API exists. |

A supported pre-Journal replica with no configured `CohortBootstrapSource` fails closed with
`JournalPublicationError`, rather than creating a second canonical bootstrap. A `JournalError`
from the source read, the arbitration, or either consumer is thrown by name.

An `unresolved-publication` answer covers an indeterminate query, an indeterminate publication,
`undefined`, `false`, and any unrecognized value. It is structurally uninstallable:
`UnresolvedStartupCanonicalBootstrap` carries `detail` and no artifact, records, or projection.

### 23.4 Creator resume

Creator resume is specified by `incremental-graph-journal-migrations.md` §6.

### 23.5 Ordinary joining installation

Joining is specified by `incremental-graph-journal-migrations.md` §7.

The installed replica after a join retains two writers' records: the canonical cut and this
replica's own J1–J3 records.

### 23.6 Journal-aware migration

Journal-aware migration is specified by `incremental-graph-journal-migrations.md` Part II
(§§9–22). The lifecycle requirement is only that it runs as exclusive maintenance and cuts
over atomically; failure leaves the previous active pair selected.

## 24. Synchronization

Ordinary synchronization requires an established receiver and one held source
`JournalSnapshot` with exact compatibility from the same immutable cut:

```text
snapshot.databaseVersion  == receiver global/version
snapshot.graphSchemeString == receiver global/graph_scheme
```

The procedure is specified by `incremental-graph-journal-sync.md`.

No computor executes during sync.

A completely absent installation uses §19, not ordinary sync. A pre-Journal installation
completes §23.2 before ordinary sync.

## 25. Controlled reset

Controlled reset is specified by `incremental-graph-journal-reset.md`. It means:

> make the receiver's projected graph equal to a chosen compatible source projection relative
> to all history currently observed

without deleting retained history.

If the held reset source is ahead for the receiver's own local writer, reset fails
`JournalWriterBehindError` before importing or authorship. This is the same corrupted or
unsupported lifecycle condition as §20; reset does not repair it and there is no
existing-writer rollback-recovery transition.

A completely absent installation does not use reset. Pre-Journal bootstrap join is also not
reset: divergent bootstrap values represent pre-existing legacy facts and do not inherit
reset's causally-later target-repair semantics.

## 26. Projection rebuild

Maintenance may rebuild graph and index state from valid retained Journal history under
exclusive ownership.

It may recreate graph sublevels and derived indexes and caches, but must not rewrite
authoritative Journal meaning merely to make replay succeed.

Projection rebuild repairs derived-state loss only. It is not a supported way to repair
missing or truncated authoritative Journal history, rollback of the active database, or an
externally mixed database image.

If authoritative history is invalid, forked, or known incomplete, rebuild fails.

## 27. User and API expectations

### `pull()`

May recompute and append Journal events. Success implies matching graph and history are
durably published.

### `invalidate()`

Records invalidation or staleness without recomputing the target. Ordinary explicit
invalidation remains node-scoped.

### inspection

Reads the materialized projection without invoking computors merely for diagnostics.

### synchronization

May change selected values, identifiers, freshness, validity, and materialization by importing
and replaying foreign-writer history and authoring required normalization; never invokes
computors. It does not repair rollback of the receiver's own writer stream.

### reset

May intentionally rebaseline observable graph state while retaining history. Success is
atomic. It does not serve as raw database rollback recovery.

### migration and startup

Graph APIs are not initialized until any required absent restore, bootstrap, migration, or
explicit rebuild and replay-validation transition completes. Routine opening of an
already-current supported database follows §21 and does not add full replay validation.

## 28. Trust and storage-fault model

Supported participants are non-adversarial but may be stale, interrupted, offline, delayed, or
incompatible.

Local persistent database state is assumed to be changed only through supported Volodyslav
transitions, except that the complete local database may disappear. Complete disappearance maps
to **Absent** and is recoverable through §19. Arbitrary partial filesystem loss, replacement
with an older database image, mixed snapshots, manual edits, and storage corruption are not
modeled as normal lifecycle evolution.

Correctness still rejects malformed state, writer forks, non-closed causal contexts, broken
reference causality, Journal and projection invariant failure, and evidence that the local
writer has lost an already-surviving suffix.

Journal 3 does not require Byzantine provenance, malicious-peer containment, general
partial-corruption repair, or semantic recovery from arbitrary filesystem damage.

## 29. Unsupported operations and states

Unsupported operations and states include:

- manually editing Journal records;
- changing one same-version record's semantic meaning while keeping its ID;
- partial deletion of a local database;
- replacing an existing local database with an older snapshot or backup;
- restoring an existing local database from an earlier checkpoint, or rewinding its remote
  publication, as release rollback; Journal 3 release recovery is forward-only per
  `$id-5083197642258146`;
- mixing records or files from different database moments;
- partially restoring local storage while retaining some old state;
- mixed record formats in one active replica;
- destructive authoritative-history truncation followed by continued same-writer authoring;
- independently cloning one writer identity into multiple live writers;
- an existing receiver whose own writer prefix is shorter than surviving supported history for
  that writer;
- persisting hostnames, Git branch names, repository locators, or other transport identities as
  IncrementalGraph implementation-owned database or recovery metadata;
- manually editing graph sublevels away from Journal replay;
- bypassing required Journal-aware version migration;
- forcing ordinary sync or reset across incompatible snapshot metadata;
- using an arbitrary current Journal snapshot in place of a frozen canonical bootstrap
  artifact;
- joining a canonical artifact whose target version or schema the running release does not
  support;
- running a semantic, time, or allocator-dependent legacy migration callback before canonical
  bootstrap identity is established;
- independently creating a second canonical pre-Journal bootstrap after a canonical artifact
  already exists;
- making a late legacy value causally later solely because bootstrap code observed the canonical
  artifact;
- using creator-resume under a fingerprint other than `artifact.creatorWriter`;
- rerunning legacy migration callbacks during creator-resume;
- continuing creator-resume when the artifact projection and persisted legacy semantic state
  disagree;
- using a maintenance proof barrier with node scope when no actual node invalidation occurred;
- using a whole-`ValueId` proof barrier when only specific incoming proof edges are being
  retired;
- using a non-total format codec which cannot rewrite retained history for target-removed node
  families; and
- treating a checkpoint as replacement authority for missing authoritative history.

Backend-specific violations which invalidate an absent-restoration source's
continuation-safety assumptions, such as silent loss or rollback of durable writer history in a
backend model that assumes monotonic publication, are likewise outside ordinary lifecycle
recovery.

Any future recovery or import behavior for a currently unsupported storage-damage case must
first change `$id-6158827469032147` and then introduce an explicit controlled transition with
stated invariants.

## 30. Corruption versus incompatibility

A database may be valid independently yet incompatible with one requested operation.

Corruption and unsupported evidence includes:

- the same writer and sequence with different bodies;
- committed stream holes;
- evidence that an existing local writer previously had a longer surviving prefix than the
  current local state;
- partial, mixed, or rolled-back local persistent state;
- non-closed semantic-event contexts;
- mixed current record formats;
- impossible `ValueId` references;
- incompatible current `NodeIdentifier` reuse;
- creator-resume artifact and local-legacy semantic disagreement;
- graph known to disagree with replay without a successful derived-state rebuild; and
- local allocator state which could reallocate an index whose earlier allocation can exist in or
  later enter supported retained history.

Incompatibility includes:

- a pre-Journal source and target bootstrap pair which cannot preserve persisted graph
  semantics exactly without running semantic, time, or allocator-dependent migration logic
  before Journal identity exists; and
- a Journal-aware source and target version pair whose canonical codec is not total over
  retained source history.

Operations fail where such evidence becomes relevant. They must not silently convert
corruption or unsupported state, or incompatibility, into absence, a fresh database, or
ordinary graph conflict.
