# Journal 3 lifecycle contract implementation audit

Audit basis: verified `next-waterfall-7f3c` at `f52b96593e3d483588cb7c6c046976a4f3a352ae` (the remote ref resolved to the same SHA). No normative specification files were changed.

## Concrete candidate: fresh initialization must not erase existing structured state

The pre-Journal lifecycle contract required version ownership and a durable-before-visible transaction boundary. In the current Journal lifecycle, a closely testable preservation obligation is that a database with structured graph/Journal state but missing `global/version` and `global/graph_scheme` must fail closed, never be treated as fresh and initialized over.

This is implemented in `backend/src/generators/incremental_graph/prepare_graph_storage.js`:

- `replicaHoldsStructuredState` checks the active identifier lookup and the `values`, `freshness`, `timestamps`, `valid`, and `journal` sublevels.
- `prepareIncrementalGraphStorage` rejects both metadata keys missing when any structured state exists, before `initializeReplicaGlobals` can write a fresh identity.
- Fresh initialization writes `global/version` and `global/graph_scheme` in a single `schemaStorage.batch` via `initializeReplicaGlobals` in `backend/src/generators/incremental_graph/database/graph_scheme.js`.
- Ordinary graph finalization in `backend/src/generators/incremental_graph/graph_state.js` awaits the durable schema batch before committing the transaction identifier lookup and allocator watermark to in-memory state.

Targeted regression evidence already present at this HEAD, `backend/tests/incremental_graph_validity.test.js`: cases `materialized node without version and graph_scheme fails closed instead of re-initializing`, `retained Journal record without version and graph_scheme fails closed instead of re-initializing`, and `non-empty identifier lookup without version and graph_scheme fails closed instead of re-initializing`. Each asserts the metadata remains absent after rejection. `backend/tests/migration_runner.test.js` additionally verifies fresh initialization belongs to graph preparation, not migration.

## Disposition of candidates checked

- **Lifecycle §5 durable-before-visible/version ownership/schema-mediated invariants:** not a behavioral regression in this candidate; durable-first publication is at `graph_state.js` transaction commit, and schema-version checks are enforced by `root_database.js` `buildSchemaStorage` before nonempty batches.
- **Migration Layer 3 coverage:** the current `docs/migration_testing.md` explicitly identifies Layer 3 as exercising the populated Journal repository. This was a false positive for the specific claim that Layer 3 disappeared; direct migration fixtures/tests provide remaining coverage.
- **`replace` identifier preservation:** current `docs/specs/keys-design.md` states migration preserves identifiers for `keep`, `replace`, and `invalidate`; current `docs/specs/migration.md` also retains it. This is present, not dropped.
- **Synchronization legacy merge obligations:** do not restore the retired structured/textual merge algorithm. The current Journal contract uses immutable foreign suffix import and semantic normalization; exact dispositions for multi-host requirements are covered by `f52b965` and `journal3_doc_contract.test.js`.

## Validation

At base `f52b96593e3d483588cb7c6c046976a4f3a352ae`, after `npm ci`:

```text
npm test -- --runInBand backend/tests/journal3_doc_contract.test.js backend/tests/incremental_graph_validity.test.js backend/tests/migration_runner.test.js
Test Suites: 3 passed, 3 total
Tests:       117 passed, 117 total
```

No implementation change or test addition was justified: the narrow candidate is already implemented and covered by focused behavior tests, and introducing a duplicate regression test would not restore missing behavior.
