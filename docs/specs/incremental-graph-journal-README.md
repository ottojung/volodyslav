# Journal 3 Specification Reading Order

Journal 3 is split by responsibility so the semantic core stays reviewable without one monolithic document.

## Core implementation path

For a first implementation pass, read these in order:

1. `incremental-graph-journal.md` — conceptual model and global invariants.
2. `incremental-graph-journal-types.md` — persisted records, causality, conflict authority, record versioning.
3. `incremental-graph-journal-well-formedness.md` — cross-record reference and causal validity.
4. `incremental-graph-journal-replay.md` — deterministic projection from retained history to current graph state.
5. `incremental-graph-journal-emission.md` — how ordinary graph transitions create journal history.
6. `incremental-graph-journal-locking.md` — serialized record allocation and atomic graph+journal publication.
7. `incremental-graph-journal-api.md` — JournalStore/snapshot/publication/import/sync/reset software boundaries.
8. `incremental-graph-journal-errors.md` — lifecycle-relevant failure categories.
9. `incremental-graph-journal-storage.md` — abstract local storage/codec/index requirements without choosing a remote backend.
10. `incremental-graph-journal-sync.md` — pairwise immutable-history replication and synchronization normalization.
11. `incremental-graph-journal-reset.md` — controlled semantic rebaseline without history deletion.
12. `incremental-graph-journal-migrations.md` — initial legacy bootstrap and later Journal-3-aware migration.

## Correctness/review material

After the core model:

- `incremental-graph-journal-properties.md` — separates immutable-history algebra from graph projection/normalization semantics;
- `incremental-graph-journal-theorems.md` — proof obligations every implementation must satisfy;
- `incremental-graph-journal-examples.md` — worked traces of difficult causal/synchronization cases;
- `incremental-graph-journal-testing.md` — differential/model/integration testing expectations;
- `incremental-graph-journal-checklist.md` — suggested implementation sequence and acceptance checks;
- `incremental-graph-journal-user-contract.md` — observable expectations for pull/invalidate/sync/reset/startup/rebuild.

## Surrounding lifecycle specifications

- `incremental-graph-synchronization.md` — lifecycle-facing synchronization contract built on Journal 3;
- `database-lifecycle.md` — open/start/migrate/sync/reset/rebuild lifecycle.

The existing IncrementalGraph semantics remain authoritative for ordinary graph computation/validity behavior; Journal 3 must project exactly into that contract rather than silently redefining it.

## One-sentence model

```text
The retained immutable journal is authority; the current IncrementalGraph database is project(journal).
```

## Deliberately outside this work

The Journal 3 semantic specification does not require a concrete hosted backend protocol such as Supabase/PostgreSQL/HTTP, a Git-specific branch/commit synchronization protocol, or destructive journal compaction.

A future transport only needs to satisfy the stable immutable `JournalSyncSource` / `JournalSnapshot` behavior required by the Journal 3 API/synchronization specifications.
