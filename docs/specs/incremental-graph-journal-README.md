# Journal 3 Specification Reading Order

Journal 3 is split by semantic responsibility. For a first implementation pass, read:

1. `incremental-graph-journal.md` — conceptual model and global invariants.
2. `incremental-graph-journal-types.md` — record identities, scopes, causality, authority.
3. `incremental-graph-journal-well-formedness.md` — context/reference/certificate validity.
4. `incremental-graph-journal-replay.md` — deterministic projection and effective proof.
5. `incremental-graph-journal-emission.md` — ordinary graph transition emission.
6. `incremental-graph-journal-locking.md` — finalization/atomic publication.
7. `incremental-graph-journal-api.md` — snapshots, recovery sources, bootstrap/migration boundaries.
8. `incremental-graph-journal-sync.md` — suffix replication, normalization, convergence.
9. `incremental-graph-journal-reset.md` — controlled rebaseline.
10. `incremental-graph-journal-migrations.md` — legacy bootstrap and Journal-aware migration.
11. `incremental-graph-journal-properties.md` — algebra/lifecycle distinctions.
12. `incremental-graph-journal-theorems.md` — proof obligations.
13. `incremental-graph-journal-examples.md` — worked counterexamples.
14. `incremental-graph-journal-errors.md` — failure categories.
15. `incremental-graph-journal-storage.md` — local persistence/codec requirements.
16. `incremental-graph-journal-user-contract.md` — observable expectations.
17. `incremental-graph-journal-testing.md` — verification strategy.
18. `incremental-graph-journal-checklist.md` — implementation acceptance checklist.

Surrounding lifecycle specs:

- `incremental-graph-synchronization.md` — IncrementalGraph-facing synchronization shell;
- `database-lifecycle.md` — restore/open/bootstrap/migrate/sync/reset/rebuild lifecycle.

## One-sentence model

```text
Retained immutable Journal history is authority; the current IncrementalGraph database is project(Journal).
```

## Key correctness commitments

Journal 3 specifies:

- one immutable contiguous stream per writer;
- transitively closed semantic contexts with exact own-writer prefix;
- causality-respecting deterministic conflict authority;
- replay-complete ValueEvents and self-describing certificates;
- certificate selection by `effectiveBasisMatchCount`, then current-value invalidation coverage, then authority;
- three distinct invalidation meanings: `node`, `value(V)`, and edge-specific `proof(V,D)`;
- maintenance proof weakening as negative **edge** evidence rather than whole-certificate invalidation;
- persistent stale markers so upstream `Unchanged` cannot erase a stored stale transition;
- commit-time Journal IDs/contexts/authority and atomic graph+Journal publication;
- stable ordinary source snapshots whose compatibility metadata and records belong to one cut;
- continuation-safe installation recovery before fresh identity generation or resumed same-writer authoring;
- ordinary synchronization importing foreign-writer suffixes, while a longer receiver-local writer prefix triggers `JournalWriterBehindError` and authoritative recovery;
- exact structural deletion only when a selected dependent loses a required materialized input; mixed input versions otherwise keep the cached value as legitimate `oldValue` and express hard/soft stale state through proof/freshness;
- a frozen canonical bootstrap artifact for the original pre-Journal cut;
- bootstrap as semantic identity over already-persisted legacy state;
- creator-resume without rerunning migration callbacks;
- historical late-host bootstrap conflicts using legacy `modifiedAt`, not upgrade time;
- exact-shared bootstrap proof intersection (`canonicalValid ∩ joiningValid`) and conservative stale merge;
- bootstrap propagation of recursive-only stale state;
- the accepted non-canonical bootstrap ValueId split trade-off `$id-1635227135166767`;
- bounded bootstrap compatibility rather than permanent support for every old artifact;
- a total deterministic whole-history database-format rewrite, including records for target-removed node families;
- representation-only Journal migration through the canonical codec + `keep`;
- `JournalVersionCompatibilityError` before cutover when that codec is not total over retained source history;
- independent genuine replacement migrations, accepting possible dependent staleness after later conflict;
- minimal deterministic reset with edge-specific proof weakening;
- no destructive authoritative-history compaction.

An implementer should not need to invent additional Journal semantics for these supported paths.

## Important regressions before implementation

The tests/examples intentionally cover at least:

- non-transitive context omission;
- competing validations where only one causally covers current-value invalidation;
- two independent migrations weakening the same preserved ValueId without destroying all proof;
- independent barriers on different inputs composing to the intended proof intersection;
- proof barrier for `(V,D)` leaving unrelated input proof and V2 untouched;
- migration/reset dependent stale only through an input remaining stale after that input later returns `Unchanged`;
- a newly selected remote dependent receiving persistent stale history;
- structural missing-input sync deleting a dependent while mere input-version mismatch keeps its cached `oldValue`;
- ordinary peer revealing a longer receiver-local writer prefix causing `JournalWriterBehindError`, not unsafe continuation;
- continuation-safe recovery rejecting a head when a higher local-writer record can later re-enter supported history;
- reset source ahead for local writer failing before import/authoring and requiring recovery first;
- pre-Journal bootstrap path requiring execution-time semantic/allocator transformation being rejected;
- creator crash after artifact publication resuming exact frozen history;
- current post-bootstrap snapshot not substituting for the original bootstrap cut;
- canonical stale/shared fresh and canonical fresh/shared stale both remaining conservatively stale;
- exact shared canonical proof edge absent from joining proof being removed with `proof(V,D)`;
- joining stale input persistently staling a canonical dependent;
- divergent legacy value authority depending on persisted `modifiedAt`, not upgrade time;
- legacy cache absence not manufacturing deletion;
- identical non-canonical late joiners possibly splitting ValueId as an explicit accepted trade-off;
- same historical ValueEvent selected on one replica but not another rewriting identically through the total codec;
- retained history for a node family removed from target schema still receiving a deterministic target-format representation;
- non-total Journal codec failing `JournalVersionCompatibilityError` before cutover;
- independent genuine replacement migration possibly staling dependents after conflict.

## Scope boundary

Journal 3 stops at semantic stable-snapshot/lifecycle boundaries. It does not prescribe Git branch/file mechanics, a hosted backend, SQL/HTTP/RPC schemas, authentication, or deployment topology.

A transport can remain unchanged if its adapter can provide the required stable ordinary snapshots, continuation-safe installation recovery, and canonical-bootstrap source semantics.

Also outside core correctness:

- destructive compaction (none required);
- persisted checkpoint format;
- high-level history UI/grouping;
- the future end-to-end change-sensitive synchronization running-time guarantee owned by #1607.
