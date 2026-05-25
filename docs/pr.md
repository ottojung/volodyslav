# PR #1376 — volatile/persistent consistency refactor (analysis)

## High-level intent

PR #1376 is a broad refactor of the incremental-graph transaction model. It shifts the system from a clone-heavy, layered synchronization approach toward a single transaction abstraction that keeps volatile (in-memory) and persistent (LevelDB) states consistent through a disk-first commit ordering.

Conceptually, the PR does four things:

1. Introduces a formal transaction/consistency model and supporting documentation.
2. Refactors runtime code to execute pull/invalidation flows within explicit transactions.
3. Reworks identifier lookup handling from full-map cloning to an overlay model.
4. Expands tests to assert atomicity, concurrency behavior, and volatile consistency properties.

## Architectural choices

### 1) Transaction as the core unit

The PR centers operations around a transaction that bundles:

- a LevelDB batch accumulator (read-your-writes semantics), and
- a transaction-scoped identifier lookup view.

This unifies nested pull behavior so dependency pulls share the outer transaction, rather than independently committing partial state.

### 2) Disk-first commit ordering

The implementation uses a strict ordering:

1. append all persistent mutations to a single batch,
2. flush batch to persistent storage,
3. only then publish volatile identifier-lookup updates.

This ordering ensures volatile state cannot “run ahead” of what is durable on disk.

### 3) Overlay identifier lookup instead of full cloning

Instead of cloning the full identifier map for each transaction (high overhead), the PR uses an overlay that tracks only new allocations. Reads check overlay first, then base committed state. Commit merges overlay into base after durable write success.

### 4) Mutexed computed-state section

Top-level transactional work is serialized under the computed-state mutex so allocation and commit logic is race-free. Nested pulls are expected to reuse the already-created transaction and must not recursively start new transactions.

## Low-level implementation surface

The PR touches these areas:

- `graph_state.js` and `graph_storage.js`: transaction lifecycle, commit path, and state publication order.
- `identifier_resolver.js` and `database/identifier_lookup.js`: lookup/allocation representation and serialization behavior.
- `pull.js`, `invalidate.js`, `recompute.js`: call-site integration with transaction passing.
- `lock.js`: mutex behavior and caller expectations.
- multiple incremental-graph tests, especially volatile-consistency and concurrency suites.
- design/spec docs under `docs/specs/` and PR-analysis docs.

## Tradeoffs in the PR

- **Pros**: stronger consistency semantics, lower asymptotic overhead for identifier handling, clearer transaction boundaries, and better testability.
- **Cons**: more conceptual machinery (transaction object + overlay + mutex discipline), and stricter internal calling contracts for nested operations.

## Why this PR matters

Without these changes, the system risks subtle mismatches between what has been persisted and what volatile structures claim is present, especially under nested pull flows and concurrent callers. PR #1376 codifies and enforces the intended consistency model while reducing avoidable cloning costs.
