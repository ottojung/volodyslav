# Journal 3 Specification Reading Order

Journal 3 is intentionally split into small normative documents rather than one monolithic specification.

For a first implementation pass, read them in this order:

1. `incremental-graph-journal.md` — conceptual model and global invariants.
2. `incremental-graph-journal-types.md` — persisted records, causality, and conflict authority.
3. `incremental-graph-journal-well-formedness.md` — cross-record reference validity.
4. `incremental-graph-journal-replay.md` — how history deterministically produces current graph state.
5. `incremental-graph-journal-emission.md` — how ordinary graph operations create history.
6. `incremental-graph-journal-locking.md` — how emission becomes one atomic graph+journal publication.
7. `incremental-graph-journal-api.md` — software boundaries, snapshots, import/publication APIs, results/errors.
8. `incremental-graph-journal-sync.md` — pairwise history replication and synchronization normalization.
9. `incremental-graph-journal-reset.md` — controlled semantic rebaseline without history deletion.
10. `incremental-graph-journal-migrations.md` — initial bootstrap and future version/schema migration.
11. `incremental-graph-journal-theorems.md` — proof obligations for implementation/tests.
12. `incremental-graph-journal-examples.md` — worked traces of difficult cases.
13. `incremental-graph-journal-checklist.md` — suggested implementation sequence/acceptance checks.

The surrounding lifecycle documents are:

- `incremental-graph-synchronization.md` — lifecycle-facing synchronization contract;
- `database-lifecycle.md` — open/start/migrate/sync/reset/rebuild lifecycle.

## One-sentence model

```text
The retained immutable journal is authority; the current IncrementalGraph database is project(journal).
```

## Deliberately outside the current Journal 3 specification

The following are not required to understand or implement the journal semantics:

- a specific hosted backend product;
- Supabase/PostgreSQL/HTTP schemas or RPCs;
- Git-specific branch/commit synchronization protocol;
- a destructive compaction design.

A transport only needs to provide the stable immutable journal-snapshot behavior required by the Journal 3 API/synchronization specs.
