# Journal 3 Specification Reading Order

Journal 3 is split by semantic responsibility so an implementer can follow one deliberate path from record model to lifecycle behavior.

For a first implementation pass, read in this order:

1. `incremental-graph-journal.md` — conceptual model, scope, global invariants.
2. `incremental-graph-journal-types.md` — record identities, causally closed contexts, event shapes, authority.
3. `incremental-graph-journal-well-formedness.md` — context/reference/certificate validity.
4. `incremental-graph-journal-replay.md` — deterministic projection and certificate selection.
5. `incremental-graph-journal-emission.md` — ordinary graph transition emission.
6. `incremental-graph-journal-locking.md` — finalization and atomic Journal/projection publication.
7. `incremental-graph-journal-api.md` — current stable snapshots, bootstrap artifacts, restore, import/publication boundaries.
8. `incremental-graph-journal-sync.md` — suffix replication, normalization, convergence.
9. `incremental-graph-journal-reset.md` — controlled semantic rebaseline, proof weakening, persistent target staleness.
10. `incremental-graph-journal-migrations.md` — canonical legacy bootstrap, creator resume, Journal-aware migration.
11. `incremental-graph-journal-properties.md` — retained-history algebra and lifecycle distinctions.
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
- a narrow pre-Journal historical-conversion rule which does not invent causality between independently existing legacy values;
- causality-respecting total conflict authority;
- replay-complete ValueEvents and self-describing validation certificates;
- certificate selection by basis applicability, then current-value invalidation coverage, then authority;
- node-scoped maintenance proof barriers when reset/migration must remove currently-valid edges from a preserved occurrence;
- persistent maintenance stale markers when a target-stale occurrence's own proof is otherwise complete, even if current replay is already stale recursively through an input;
- ordinary event emission with commit-time IDs/contexts/HLC allocation;
- stable ordinary source snapshots whose compatibility metadata and records belong to one source cut;
- receiver-less restoration before fresh identity generation for absent installation;
- exact same-writer prefix recovery for an existing behind Journal receiver;
- suffix synchronization and persistent normalization;
- one immutable canonical bootstrap artifact per supported legacy synchronization cohort, frozen at original bootstrap frontier/target version-schema;
- exact creator-resume after artifact-publication/local-cutover crash, with semantic mismatch rejected as `JournalBootstrapForkError`;
- late bootstrap joining as historical legacy-state merge rather than reset: equal occurrences share canonical ValueIds, divergent values remain concurrent, legacy modifiedAt drives normal conflict preference, and cache absence does not become deletion evidence;
- accepted identity split for independently converted identical **non-canonical** legacy occurrences (`$id-1635227135166767`);
- bootstrap support bounded by the running release's explicitly supported bootstrap target rather than permanent compatibility with every historical artifact;
- preservation of ValueIds across `keep`, `override`, `invalidate`, proof-only, freshness-only, and other occurrence-preserving migration changes;
- one pure per-record database-format rewrite for retained history, independent of selected/non-selected status;
- `override()` as assertion against canonical rewrite rather than replica-local immutable-record mutation;
- independent Journal-aware migration for genuine replacement occurrences, accepting possible downstream staleness after later synchronization;
- minimal deterministic reset separating value identity from proof/freshness repair;
- one current persisted format per active database;
- no destructive authoritative history compaction;
- explicit correctness laws, regression traces, errors, and acceptance tests.

An implementer should not need to invent additional Journal semantics for these supported paths.

## Important regressions to understand before implementation

The worked examples/tests intentionally include these non-obvious failures which normative rules prevent or explicitly bound:

- A observes B which observed C, but A's persisted context omits C -> malformed non-transitive history;
- two equally matching validations compete, but only one causally covers current-value invalidation -> covering certificate wins before clock authority;
- a later weaker maintenance certificate is intended to remove an old validity edge -> without node-scoped proof barrier, older stronger certificate would keep winning;
- a migration/reset dependent is target-stale only because an input is stale -> without current-value marker, later upstream `Unchanged` could freshen dependent incorrectly;
- a newly selected remote dependent is stale only because direct input is stale -> synchronization persists that occurrence's staleness;
- creator publishes bootstrap artifact and crashes before local cutover -> restart resumes exact artifact rather than getting stuck or duplicating history;
- creator-resume artifact projection disagrees with local legacy state -> bootstrap fork, not silent continuation;
- a late host receives current post-bootstrap snapshot instead of frozen bootstrap cut -> stale legacy state could overwrite newer Journal history;
- a late divergent legacy value is authored causally after canonical value merely because migration read it -> upgrade time would incorrectly beat legacy modifiedAt conflict semantics;
- two late joiners carry same non-canonical legacy occurrence -> they may receive distinct ValueIds and later stale dependents; this is explicit accepted trade-off, not hidden guarantee;
- a canonical materialization is absent from one legacy cache -> bootstrap must not manufacture deletion;
- old bootstrap artifact no longer matches running release's supported target -> compatibility failure instead of permanent historical compatibility machinery;
- same historical ValueEvent is selected on one replica but not another during format migration -> both rewrite it identically;
- `override()` callback produces bytes different from pure canonical codec -> migration fails rather than forking one JournalRecordId;
- genuine replacement occurrences are independently migrated -> later synchronization may stale dependents whose certificate names losing replacement;
- no local database but synchronized installation state exists -> restore continuing writer identity rather than silently create fresh fingerprint.

## Scope boundary

Journal 3 stops at the semantic stable-snapshot/lifecycle boundary.

It does not specify or require changes to existing Git branch/commit/file transport behavior, a hosted synchronization backend, Supabase/PostgreSQL/HTTP schemas or RPCs, or authentication/deployment topology.

A transport may continue to work as it does today if its adapter can provide required stable ordinary snapshot, installation-recovery, and cohort-bootstrap-source semantics for versions the running software supports. How those abstractions are carried or persisted is outside Journal semantics.

Also outside core correctness:

- destructive compaction (there is none);
- persisted checkpoint format (optional derived acceleration);
- high-level operation grouping/history UI (optional diagnostics);
- end-to-end change-sensitive synchronization running-time guarantee owned by #1607.

These are explicit scope boundaries/deferred optimizations, not missing Journal semantics.
