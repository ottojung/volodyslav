# Journal 3 Specification Reading Order

Journal 3 is split by semantic responsibility so an implementer can follow one deliberate path from record model to lifecycle behavior.

For a first implementation pass, read in this order:

1. `incremental-graph-journal.md` — conceptual model, scope, global invariants.
2. `incremental-graph-journal-types.md` — record identities, causally closed contexts, event shapes, authority.
3. `incremental-graph-journal-well-formedness.md` — context/reference/certificate validity.
4. `incremental-graph-journal-replay.md` — deterministic projection and certificate selection.
5. `incremental-graph-journal-emission.md` — ordinary graph transition emission.
6. `incremental-graph-journal-locking.md` — finalization and atomic Journal/projection publication.
7. `incremental-graph-journal-api.md` — stable snapshots, receiver-less restore, import/publication boundaries.
8. `incremental-graph-journal-sync.md` — suffix replication, normalization, convergence.
9. `incremental-graph-journal-reset.md` — minimal controlled semantic rebaseline.
10. `incremental-graph-journal-migrations.md` — canonical legacy bootstrap, join-with-delta, and occurrence-preserving migration.
11. `incremental-graph-journal-properties.md` — retained-history algebra and normalization distinctions.
12. `incremental-graph-journal-theorems.md` — proof obligations.
13. `incremental-graph-journal-examples.md` — worked traces/counterexamples.
14. `incremental-graph-journal-errors.md` — failure categories.
15. `incremental-graph-journal-storage.md` — local persistence/codec requirements.
16. `incremental-graph-journal-user-contract.md` — observable caller expectations.
17. `incremental-graph-journal-testing.md` — differential/property/regression testing.
18. `incremental-graph-journal-checklist.md` — implementation sequence/acceptance checks.

Surrounding lifecycle specifications:

- `incremental-graph-synchronization.md` — IncrementalGraph-facing synchronization shell;
- `database-lifecycle.md` — startup/restore/open/migrate/sync/reset/rebuild lifecycle.

## One-sentence model

```text
Retained immutable Journal history is authority; the current IncrementalGraph database is project(journal).
```

## Key correctness commitments

Within Journal 3 scope the specification defines:

- one immutable contiguous stream per writer;
- semantic-event contexts as transitively causally closed cuts, including exact own-writer prefix;
- causality-respecting total conflict authority;
- replay-complete ValueEvents and self-describing validation certificates;
- certificate selection by basis applicability, then current-value invalidation coverage, then authority;
- ordinary event emission with commit-time IDs/contexts/HLC allocation;
- stable source snapshots whose compatibility metadata and records belong to one source cut;
- receiver-less restoration before fresh identity generation for an absent installation;
- exact same-writer prefix recovery for an existing behind receiver;
- suffix synchronization and persistent normalization;
- one canonical semantic bootstrap basis per legacy synchronization cohort, selected through a three-outcome cohort-bootstrap-source decision;
- join-with-delta so late/divergent legacy hosts retain canonical ValueIds for unaffected nodes while preserving local differences;
- preservation of ValueIds across `keep`, `override`, `invalidate`, proof-only, freshness-only, and other occurrence-preserving migration changes;
- independent Journal-aware migration for genuine replacement occurrences, accepting possible downstream staleness after later synchronization;
- minimal deterministic reset separating value identity from proof/freshness repair;
- one current persisted format per active database;
- no destructive authoritative history compaction;
- explicit correctness laws, regression traces, errors, and acceptance tests.

An implementer should not need to invent additional Journal semantics for these paths.

## Important regressions to understand before implementation

The worked examples/tests intentionally include these non-obvious failures which the normative rules prevent:

- A observes B which observed C, but A's persisted context omits C -> malformed non-transitive history;
- two equally matching validations compete, but only one causally covers a current-value invalidation -> the covering certificate wins before clock authority;
- a newly selected remote dependent is stale only because its direct input is stale -> synchronization persists that occurrence's staleness;
- two legacy hosts independently mint full equivalent bootstrap histories -> unsupported; a cohort shares one canonical basis, while a late host adds only its local delta;
- cohort bootstrap source is unavailable/indeterminate -> fail rather than race a second canonical creator;
- `override()` changes representation but not semantic value -> preserve the selected ValueId;
- a database version changes only schema/proof/freshness -> preserved cached occurrence keeps its ValueId;
- genuine replacement occurrences are independently migrated -> later synchronization may stale dependents whose certificate names the losing replacement;
- reset changes only proof/freshness -> preserved value occurrence keeps its ValueId;
- no local database but synchronized installation state exists -> restore continuing writer identity rather than silently create a fresh fingerprint.

## Scope boundary

Journal 3 stops at the semantic stable-snapshot/lifecycle boundary.

It does not specify or require changes to existing Git branch/commit/file transport behavior, a hosted synchronization backend, Supabase/PostgreSQL/HTTP schemas or RPCs, or authentication/deployment topology.

A transport may continue to work as it does today if its adapter can provide the required stable snapshot/recovery-source/cohort-bootstrap-source semantics.

Also outside core correctness:

- destructive compaction (there is none);
- persisted checkpoint format (optional derived acceleration);
- high-level operation grouping/history UI (optional diagnostics);
- end-to-end change-sensitive synchronization running-time guarantee owned by #1607.

These are explicit scope boundaries/deferred optimizations, not missing Journal semantics.