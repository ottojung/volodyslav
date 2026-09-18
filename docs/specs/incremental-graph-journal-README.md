# Journal 3 Specification Reading Order

Journal 3 is split by semantic responsibility. For a first implementation pass, read:

1. `incremental-graph-journal.md` — conceptual model and global invariants.
2. `incremental-graph-journal-types.md` — record identities, scopes, causality, authority.
3. `incremental-graph-journal-well-formedness.md` — context/reference/certificate validity.
4. `incremental-graph-journal-replay.md` — deterministic projection and effective proof.
5. `incremental-graph-journal-emission.md` — ordinary graph transition emission.
6. `incremental-graph-journal-locking.md` — finalization/atomic publication.
7. `incremental-graph-journal-api.md` — snapshots, absent restoration sources, bootstrap/migration boundaries.
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

## Normative ownership

Each semantic rule has one normative owner. Other Journal documents may summarize consequences, expose API/error behavior, state proof obligations, or define tests, but they do not redefine the owned rule. If wording drifts, the owner below wins.

- record shapes, identity primitives, causal/authority data: `incremental-graph-journal-types.md`;
- well-formedness, context/reference legality, certificate eligibility: `incremental-graph-journal-well-formedness.md`;
- replay, effective proof, certificate selection, freshness/validity projection: `incremental-graph-journal-replay.md`;
- ordinary-operation Journal emission: `incremental-graph-journal-emission.md`;
- pairwise synchronization import, normalization, convergence, and the host-count settling construction: `incremental-graph-journal-sync.md`;
- lifecycle fault model, established-writer rollback boundary, and absent-installation restoration: `database-lifecycle.md`;
- general migration API/codec semantics: `migration.md`;
- Journal bootstrap and Journal-aware migration procedure: `incremental-graph-journal-migrations.md`;
- reset procedure: `incremental-graph-journal-reset.md`;
- regression/property inventory: `incremental-graph-journal-testing.md`.

`incremental-graph-journal-theorems.md` states proof obligations derived from these definitions; `incremental-graph-journal-properties.md` explains algebraic consequences; `incremental-graph-journal-api.md`, `incremental-graph-journal-errors.md`, and `incremental-graph-journal-user-contract.md` expose boundaries/consequences; and `incremental-graph-journal-checklist.md` is an implementation checklist. None of those files is a competing definition of an owned semantic rule.

## Scope boundary

Journal 3 stops at semantic stable-snapshot/lifecycle boundaries. It does not prescribe Git branch/file mechanics, a hosted backend, SQL/HTTP/RPC schemas, authentication, or deployment topology.

A transport can remain unchanged if its adapter can provide the required stable ordinary snapshots, continuation-safe **absent-installation** restoration, and canonical-bootstrap source semantics. How absent-restoration safety is established is backend-specific; Journal 3 requires only the resulting guarantee and does not prescribe a single recovery authority, source count, storage topology, or publication protocol.

Also outside core correctness:

- destructive compaction (none required);
- persisted checkpoint format;
- high-level history UI/grouping;
- the future end-to-end change-sensitive synchronization running-time guarantee owned by #1607.
