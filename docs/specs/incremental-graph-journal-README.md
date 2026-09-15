# Journal 3 Specification Reading Order

Journal 3 is split by semantic responsibility so an implementer can follow one deliberate path from record model to lifecycle behavior.

For a first implementation pass, read them in this order:

1. `incremental-graph-journal.md` — conceptual model, scope, and global invariants.
2. `incremental-graph-journal-types.md` — persisted records, self-describing certificates, causality, and conflict authority.
3. `incremental-graph-journal-well-formedness.md` — cross-record reference validity and canonical certificate rules.
4. `incremental-graph-journal-replay.md` — how retained history deterministically produces current graph state.
5. `incremental-graph-journal-emission.md` — how ordinary graph operations create replay-complete history.
6. `incremental-graph-journal-locking.md` — how staged effects become one atomic graph+journal publication.
7. `incremental-graph-journal-api.md` — software boundaries, stable snapshots including version/schema compatibility metadata, import/publication APIs, results, and errors.
8. `incremental-graph-journal-sync.md` — pairwise history replication, normalization, and fair-execution convergence.
9. `incremental-graph-journal-reset.md` — controlled semantic rebaseline without history deletion.
10. `incremental-graph-journal-migrations.md` — initial bootstrap and future whole-database version/schema migration.
11. `incremental-graph-journal-properties.md` — retained-history algebra and the distinction between union and semantic normalization.
12. `incremental-graph-journal-theorems.md` — proof obligations for implementation/tests.
13. `incremental-graph-journal-examples.md` — worked traces of difficult cases.
14. `incremental-graph-journal-errors.md` — operationally meaningful failure categories.
15. `incremental-graph-journal-storage.md` — local persistence/codec/snapshot requirements without transport design.
16. `incremental-graph-journal-user-contract.md` — observable expectations of graph/lifecycle callers.
17. `incremental-graph-journal-testing.md` — differential/property/convergence/corruption test strategy.
18. `incremental-graph-journal-checklist.md` — suggested implementation sequence and acceptance checks.

The surrounding lifecycle documents are:

- `incremental-graph-synchronization.md` — lifecycle-facing synchronization contract;
- `database-lifecycle.md` — open/start/migrate/sync/reset/rebuild lifecycle.

## One-sentence model

```text
The retained journal is authority; the current IncrementalGraph database is project(journal).
```

## Specification completeness

Within the Journal 3 scope, the semantic design now specifies:

- persisted record identities/shapes under one current whole-database `global/version` representation;
- deterministic whole-journal representation rewrite at database migration boundaries while preserving historical record IDs/meaning;
- causal/reference well-formedness and conflict authority;
- replay/projection, including self-describing validation certificates;
- ordinary local event emission and commit-time allocation;
- graph+journal locking and atomic publication;
- stable-snapshot/range software interfaces, including exact `global/version` and exact `global/graph_scheme` metadata from the same source snapshot cut;
- suffix synchronization, same-writer recovery, semantic normalization, and convergence;
- persistent stale propagation for the selected current occurrence even when synchronization selects a new remote `ValueId`;
- reset/rebaseline semantics with compatibility checked from the same held source snapshot;
- pre-Journal-3 bootstrap and later schema/version migration;
- local storage/codec requirements;
- correctness laws, worked traces, tests, and implementation acceptance criteria.

An implementer should not need to invent additional Journal semantics for those paths. Production implementation details may vary where the specifications explicitly leave representation or optimization choices open.

## Scope boundary

The Journal 3 specification deliberately stops at the semantic stable-snapshot boundary.

It does **not** specify or require changes to:

- Git branch/commit/file transport behavior;
- a hosted synchronization backend;
- Supabase/PostgreSQL/HTTP schemas or RPCs;
- authentication/deployment topology.

A transport may continue to work as it does today as long as its adapter can provide the stable journal snapshot semantics required by Journal 3, including compatibility metadata and journal history from one immutable source cut.

Also deliberately outside core correctness:

- destructive compaction (there is none);
- a persisted checkpoint format (checkpoints are optional derived acceleration);
- high-level operation grouping/history UI (optional non-authoritative diagnostics);
- the end-to-end change-sensitive synchronization time bound owned by #1607.

Those are intentional non-requirements/deferred optimizations, not missing Journal 3 semantic specification.
