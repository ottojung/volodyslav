---
title: Database Lifecycle
---

# Volodyslav Database Lifecycle

## 1. Overview

This document specifies the supported lifecycle of Volodyslav's synchronized IncrementalGraph database under Journal 3.

It describes creation/open, ordinary evolution, migration, synchronization, controlled reset, recovery, and rejection of unsupported state.

The key Journal 3 lifecycle law is:

```text
for every current Journal-3-aware database:
    persisted materialized graph == project(retained journal)
```

The journal is semantic authority. The current IncrementalGraph sublevels are a materialized projection.

This is a lifecycle specification, not a transport/backend specification. A source journal might currently be carried by one mechanism and later by another. The lifecycle requires stable Journal 3 snapshots/prefixes and atomic local publication; it does not prescribe a hosted database, Git layout, HTTP protocol, or remote schema.

The normal user-facing startup operation remains:

```sh
volodyslav start
```

Raw filesystem/database manipulation is not a supported lifecycle transition.

## 2. Lifecycle states

At the lifecycle level a local database is one of:

- **Absent** — no local supported database has been established for this installation.
- **Legacy/migratable** — a structurally valid older database exists and the running version supplies a supported migration into the current representation.
- **Current** — database version/schema match the running application and, when Journal 3 is established, its materialized graph matches its retained journal projection.
- **Incompatible for an operation** — the database may be valid independently but a requested synchronization/reset/migration compatibility precondition is not satisfied.
- **Corrupted/unsupported** — required invariants fail, writer history forks, graph and authoritative journal disagree without a supported rebuild path, or the state was produced outside the supported lifecycle.

Supported transitions are:

1. **fresh bootstrap** — absent state becomes a new empty current database;
2. **same-writer restoration/recovery** — an absent/behind installation resumes an exact immutable prefix of its continuing writer history;
3. **open** — an existing state is validated and interpreted;
4. **ordinary evolution** — graph operations transactionally append journal history and matching projection changes;
5. **migration/bootstrap-to-Journal-3** — an older valid representation becomes current through the migration gate;
6. **synchronization** — missing immutable history is incorporated and replayed;
7. **controlled reset** — the current observed history is rebaselined to a chosen source projection without deleting history;
8. **projection rebuild** — derived graph/index state is reconstructed from retained authoritative Journal 3 history.

A successful startup ends in **Current** before database-backed application APIs are exposed as initialized.

## 3. Startup flow

`volodyslav start` initializes environment/capabilities and establishes one current database before exposing the application graph.

Conceptually:

1. validate required local operating context;
2. determine whether supported local state exists;
3. if absent, run the configured controlled creation/recovery path;
4. open local persistence;
5. run the database-version migration gate;
6. for Journal-3-aware state, validate/reconstruct required journal-derived caches/projection invariants;
7. construct/expose the IncrementalGraph interface.

Startup does not silently reinterpret malformed/incompatible existing state as an empty database.

Routine startup of an already-current local database does not imply ordinary multi-source synchronization unless an outer application policy explicitly requests it. Synchronization remains a controlled administrative operation.

Startup/migration/rebuild/cutover are exclusive with ordinary graph activity.

## 4. Fresh database creation

### 4.1 Fresh identity

A genuinely new writable database receives one durable `DatabaseFingerprint`, which is its Journal 3 writer identity.

It begins with:

```text
local writer frontier = 0
retained foreign frontiers = 0
materialized graph = empty
```

and therefore:

```text
project(empty journal) = empty graph
```

The database records the running database version/schema metadata required by the existing graph lifecycle.

No semantic event is required merely to state that infinitely many possible semantic nodes are absent.

### 4.2 Local allocation state

A fresh local `last_node_index` begins according to the ordinary identifier-allocation specification (currently zero).

Journal writer-state history need only be written when required by the Journal 3 writer-state representation. Replay of a genuinely empty fresh database must reconstruct the initial allocator state deterministically.

## 5. Same-writer restoration and recovery

Journal 3 treats restoration primarily as immutable prefix recovery rather than graph snapshot replacement.

Suppose local writer A is absent/behind and a controlled source retains:

```text
A:1..q
```

If the local copy is empty or an exact prefix of that same history, the lifecycle may import/recover the missing A suffix under exclusive maintenance, together with all causally required retained foreign history.

After recovery it reconstructs:

- local writer head;
- local `last_node_index`;
- authority high-water;
- materialized graph projection;
- derived indexes/caches.

New A-authored records begin after q.

No reset baseline is necessary when the requested operation is simply resuming the continuing immutable history.

If overlapping A records disagree, the writer history has forked/corrupted. Restoration fails; it must not choose one body by timestamp or payload equality.

Two independently live installations intentionally authoring under one fingerprint are outside the supported lifecycle.

## 6. Opening Journal-3-aware state

Opening a current Journal 3 database establishes one coherent pair:

```text
(retained journal, materialized projection)
```

Required checks/rebuild policy may be staged for performance, but the supported result must satisfy:

- writer streams are structurally valid/contiguous;
- journal record decoding/compatibility succeeds;
- persisted current database version/schema is compatible with the running interpretation;
- materialized graph is observationally equivalent to Journal 3 replay, or a supported projection-rebuild path reconstructs it before exposure;
- local writer allocator state is consistent with retained local history.

The graph must not be exposed if the implementation knows journal/projection state disagree and has not successfully rebuilt/validated the projection.

## 7. Ordinary database evolution

After startup, graph state changes through supported IncrementalGraph APIs such as pull/recompute/invalidate and domain operations built on them.

For every successful semantic transition:

```text
project(journalAfter) == graphAfter
```

Journal 3 event emission is defined by `incremental-graph-journal-emission.md`.

Publication/locking is defined by `incremental-graph-journal-locking.md`.

Lifecycle invariants include:

1. **version ownership** — writes target the current running database/schema version;
2. **journal-first semantic authority** — every persisted graph change has replay explanation;
3. **atomic publication** — journal and graph transition commit together;
4. **durable-before-visible state** — matching volatile caches publish only after durable success;
5. **exclusive maintenance** — migration/sync/reset/rebuild cannot overlap ordinary graph activity at cutover;
6. **schema-mediated access** — callers do not mutate persistence/journal records directly.

A successful ordinary operation which changes no persisted semantic graph fact need not append a semantic event merely because the API was called.

## 8. Migration

Migration is the controlled transition between database versions/schema interpretations.

Detailed Journal 3 rules are normative in `incremental-graph-journal-migrations.md`.

### 8.1 Migration gate

After open:

- matching version -> no migration;
- supported older version -> run its migration;
- unsupported/incompatible version -> fail startup;
- legacy/pre-Journal-3 version which has a supported Journal 3 bootstrap migration -> validate legacy state then construct the replay baseline defined by the Journal 3 migration spec.

Absence of a stored version is treated as fresh only under the existing fresh-database lifecycle rules; it must not be used to erase an existing structured database which merely has malformed/missing metadata.

### 8.2 Journal 3 migration meaning

A Journal-3-aware migration:

1. starts from a valid source pair `Gbefore = project(Jbefore)`;
2. computes the ordinary migration target `Gtarget` under isolated target storage;
3. appends replay-complete migration baseline records causally after the source history;
4. verifies `project(Jafter,targetSchema) == Gtarget`;
5. atomically cuts over to the target version/journal/projection.

Old journal history is retained.

Future replay uses the recorded migration result; it does not rerun the historical migration callback.

### 8.3 Failure

Failure before cutover leaves the previous active supported database selected.

Operational work after a successful durable cutover may fail independently; callers must distinguish a failed post-cutover bookkeeping step from a migration whose database transition never committed.

## 9. Synchronization

Journal 3 synchronization is specified by `incremental-graph-journal-sync.md` and the lifecycle shell in `incremental-graph-synchronization.md`.

### 9.1 Compatibility

Ordinary synchronization requires compatible current database/schema interpretation.

A version mismatch is an incompatibility condition, not permission to perform migration implicitly inside sync.

Both replicas must first reach a supported compatible version through migration.

### 9.2 Pairwise source flow

For one stable source snapshot:

1. enter exclusive synchronization maintenance ownership as required by the locking design;
2. open/capture the receiver's current journal/projection;
3. stream missing immutable writer suffixes into inactive staging;
4. reject any same-ID content disagreement;
5. validate causal closure/prefix integrity;
6. author required receiver-local sync normalization events;
7. compute/validate the final replay projection;
8. atomically cut over to `(targetJournal, project(targetJournal))`.

No computor is invoked.

### 9.3 Multi-source partial success

An outer synchronization operation may process several sources independently.

Each successful pairwise source commit remains valid even if a later source fails, unless the outer lifecycle explicitly implements one stronger all-sources transaction.

Therefore an aggregate sync error may coexist with successfully incorporated history from earlier sources.

### 9.4 No transport authority

Transport may discover/carry stable Journal 3 source snapshots, but transport branches/commits/files/IDs do not decide graph conflicts.

Graph meaning is determined by journal record identity/causality/authority and replay.

## 10. Controlled reset

Controlled reset is specified by `incremental-graph-journal-reset.md`.

Reset means:

> make the receiver's projected semantic graph equal to a chosen source projection relative to all history currently observed by reset

It does **not** mean delete/replace journal history.

Reset:

1. obtains/imports the chosen stable source history;
2. observes receiver + source history;
3. appends a causally later receiver-authored baseline representing the chosen source graph state;
4. atomically publishes the retained history + reset baseline + matching projection.

A future unseen concurrent event may still conflict normally when learned later. Reset cannot dominate history it never observed without violating the no-remote-participation design.

Same-writer prefix catch-up without semantic replacement is restoration, not reset.

## 11. Projection rebuild

Journal 3 permits an administrative maintenance operation equivalent to:

```text
rebuildProjectionFromJournal()
```

under exclusive maintenance.

Its input is the valid retained journal + current compatible schema/version interpretation.

It may discard/recreate derived:

- identifiers/value/freshness/timestamp/valid sublevels;
- reverse indexes;
- cached current-head/frontier/high-water state;
- other replay accelerators.

It must not rewrite authoritative journal records merely to make replay succeed.

If replay itself detects invalid/forked/corrupt authoritative history, rebuild fails.

## 12. User/API expectations

### `pull()` / graph `POST`

May recompute and therefore append Journal 3 events. Success means the returned/inspectable materialized graph is already atomically consistent with retained journal history.

### `invalidate()` / graph `DELETE`

Does not recompute. It records the invalidation/staleness transition and publishes its graph/journal effect atomically.

### graph inspection `GET`

Remains non-triggering. It reads the materialized projection; it does not call computors merely to answer diagnostics.

### synchronization

May change cached values, identifiers, freshness, validity, and materialization by importing/replaying history, but never invokes computors. A successful pairwise sync leaves one valid journal/projection pair. Repeating against an unchanged already-incorporated source is a semantic no-op.

### reset

May replace the observable projected graph with the chosen source target without erasing old history. Success is atomic.

### migration/startup

Application graph APIs are not considered initialized until required migration/bootstrap/replay validation has completed.

## 13. Trust and threat model

Volodyslav assumes supported participants are non-adversarial.

Hosts may be stale, interrupted, offline, delayed, or incompatible. They are not assumed to forge records deliberately or launch Byzantine/resource attacks.

Correctness still requires rejection of observable malformed state, writer forks, broken causal closure, and journal/projection invariant failures.

Journal 3 does not require cryptographic Byzantine provenance merely to distinguish supported immutable record identity.

## 14. Unsupported operations

Outside the supported lifecycle:

- manually editing journal records;
- changing one record body while retaining its `(author,sequence)` ID;
- destructively truncating established authoritative history and then continuing the same writer as if nothing happened;
- independently cloning one writer identity into multiple live writers;
- manually editing graph sublevels so they disagree with their authoritative Journal 3 projection;
- bypassing required version migration;
- forcing ordinary sync across incompatible versions;
- treating a replay checkpoint/cache as replacement authority for missing journal history.

If such recovery/import behavior becomes required, it must be introduced as an explicit controlled lifecycle transition with stated invariants.

## 15. Corruption/incompatibility distinction

A state can be valid yet incompatible with a requested operation, for example a supported peer at another database version.

Corruption/unsupported state includes observable violations such as:

- same writer/sequence with different record bodies;
- impossible stream holes in a committed prefix;
- malformed historical record encoding;
- a semantic event whose required causal context is permanently absent from the claimed supported journal;
- incompatible current `NodeIdentifier` reuse;
- graph materialization known to disagree with replay when no supported derived-state rebuild has repaired it;
- writer allocator state which would reuse already-retained local journal IDs.

Operations fail at the boundary where such evidence becomes relevant. They must not silently convert corruption into a fresh database or a normal graph conflict.
