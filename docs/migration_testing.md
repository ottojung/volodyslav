# Migration testing in Volodyslav

This page explains how Volodyslav tests incremental-graph migrations at two complementary levels:

1. **Mechanics-level migration tests** that validate the migration protocol itself.
2. **Fixture-level migration + smoke tests** that validate behavior on realistic repository state.

The goal is confidence in both **correctness of the migration engine** and **real-world usability of migrated data**.

---

## Mental model: what a migration must guarantee

At startup, the incremental graph compares:

- the **stored version** in the active replica namespace, and
- the **current application version**.

If versions differ, migration runs in a staged replica and then swaps the active replica pointer.

Startup then runs the Journal 3 canonical-bootstrap gate, which is a separate step with a
separate decision:

- a replica that is fresh, empty, or already retains Journal records is left alone
  (`no-pre-journal-state`);
- a replica that is a supported pre-Journal source is offered to the cohort, and the
  resolved canonical cut is installed into the inactive replica before the replica pointer
  moves (`canonical-bootstrapped`);
- an indeterminate cohort answer installs nothing and fails startup
  (`unresolved-canonical-bootstrap`, raised as `UnresolvedCanonicalBootstrapError`).

Ordinary synchronization runs after both gates. Synchronization does not perform the
pre-Journal bootstrap, and a fixture that represents pre-Journal state brings its own
`CohortBootstrapSource`, because that transport is deployment configuration rather than
persisted database state.

Conceptually, migration must preserve these invariants:

- **No partial cutover**: users either stay on old state or atomically switch to fully migrated state.
- **Deterministic graph structure**: especially valid ordering and topology-sensitive structures.
- **Decision completeness**: every materialized old node must receive exactly one migration decision.
- **Failure isolation**: failed attempts must not corrupt the active replica.

The migration test suite is organized to prove these invariants from different angles.

---

## Layer 1 — migration runner and storage unit/integration tests

The core engine is tested directly via `runMigration`, plus supporting storage logic.

### What these tests are trying to prove

The tests in `backend/tests/migration_runner.test.js`, `backend/tests/migration_storage.test.js`, and the focused `migration_runner_timestamps` tests collectively validate:

- migration gate behavior (fresh DB, already-current DB, version mismatch),
- checkpoint boundaries (pre/post migration commits),
- callback/finalization failure semantics,
- replica-switch ordering guarantees,
- x-replica preservation on failure,
- metadata/version write rules,
- deterministic valid output,
- timestamp copy semantics.

This layer is intentionally close to internals. It catches protocol regressions fast, before full end-to-end smoke signals.

### Why this layer matters

If this layer fails, migration is unsafe even if UI-level smoke tests pass. These tests are the “spec lock” for the migration contract.

---

## Layer 2 — fixture migration test on a mock repository

File: `backend/tests/migration_fixture_populated_remote.test.js`.

This is the test that performs migration against a **mock remote repository fixture** representing a prior version (`populated-lastversion`) and then verifies exact rendered output equivalence with the current expected fixture (`populated`).

### High-level approach

1. Build capabilities (environment/logger/datetime stubs and forced app version).
2. Seed a mocked incremental-database remote branch from the old-version fixture.
3. Initialize the interface. Startup runs the migration gate and then the
   canonical-bootstrap gate before any graph API is exposed; only then does the test
   trigger synchronization.
4. Clone the resulting remote branch.
5. Compare its rendered database directory against the canonical “current populated” fixture.

### Why exact directory comparison is powerful

This test acts like a golden-output test for migration. Instead of asserting many tiny fields, it verifies the complete rendered shape produced by migration. That gives high confidence that:

- migrated keys and values match expected representation,
- rendered materialization is stable,
- migration side effects are not accidentally omitted.

It also remains reasonably robust because it compares canonical fixture directories rather than low-level LevelDB internals.

### Journal 3 startup canonical bootstrap

The same file also owns the describe block "Journal 3 startup canonical bootstrap over the
pre-Journal fixture", over `mock-incremental-database-remote-populated-lastversion`. That
fixture is a supported pre-Journal source (fingerprint `testfingerprnt`, stored version
`0.0.0-dev-previous`), and the block covers:

- the fixture is a supported pre-Journal source;
- a cohort holding nothing publishes the fixture's own canonical cut and startup resumes the
  creator (one query, one publication, one projected occurrence per materialized legacy
  node, target version `0.0.0-dev`);
- an indeterminate answer is unresolved and installs nothing, asserted by the absence of
  `records` and `projection` on the result;
- a pre-Journal fixture with no configured cohort source fails closed.

The block reads a rendered fixture off disk through `backend/tests/journal_startup_fixture.js`
rather than through a live replica. That helper builds the same weak observation
`readPreJournalSourceState` builds from a live replica, and supplies the fixture's own
`CohortBootstrapSource`.

---

## Layer 3 — smoke test that exercises the migrated repository

File: `backend/tests/populated_incremental_database_remote_smoke.test.js`.

This is the behavioral smoke test over a realistic populated fixture. It ensures the repository is not just structurally migrated, but also **operationally healthy** through the public interface.

### What this smoke test covers

After startup completes its migration and canonical-bootstrap gates over fixture-backed
remote state, it exercises:

- initialization and synchronization lifecycle,
- core reads (`getAllEvents`, `getEvent`, `getConfig`),
- derived nodes (`events_count`, sorted views, cached first/last entries),
- ordering properties (ascending/descending consistency),
- mutation flow (`update` with new events),
- follow-up reads and contextual queries,
- post-mutation synchronize durability.

### Why this smoke test is essential

The migration fixture equivalence test proves “the bytes look right.”
The smoke test proves “the app still behaves right.”

Together they reduce blind spots:

- **equivalence without usability** risk, and
- **usability with hidden structural drift** risk.

### Journal 3 startup lifecycle

The same file also owns the describe block "populated fixture in the Journal 3 startup
lifecycle", over `mock-incremental-database-remote-populated`. That fixture is already a
Journal replica — current version, and more than zero retained `record|` keys — so startup
leaves it alone and never bootstraps it a second time. The block also checks that the
fixture's persisted graph is one the canonical-bootstrap creator can stage and resume, using
the identifiers the replica already stores and the `last_node_index` it already persists.

Startup itself is covered end to end by `backend/tests/journal_startup_lifecycle.test.js`,
which drives `InterfaceClass.ensureInitialized` over live replicas built by the production
path, including a live database left as supported pre-Journal state.

---

## Design philosophy behind the migration test stack

Volodyslav’s migration testing uses a **pyramid with explicit contracts**:

- **Protocol tests** (runner/storage): strict migration semantics.
- **Fixture migration test**: canonical rendered output reproduction.
- **Behavioral smoke test**: end-user graph operations over migrated state.

This design optimizes for:

- **early failure localization** (unit/integration layer pinpoints invariant breaches),
- **high confidence in real workflows** (smoke layer validates practical correctness),
- **reduced brittleness** (focus on stable contracts, not incidental implementation details).

---

## Practical guidance for contributors

When changing migration logic, prefer this workflow:

1. Run focused migration protocol tests first (`migration_runner`, `migration_storage`, valid/timestamps).
2. Run fixture migration equivalence test.
3. Run populated remote smoke test.
4. Only then run broader test suites.

If a migration change is intentional and alters canonical rendered output, update fixtures deliberately and explain why in the change description.

---

## Summary

Migration confidence in Volodyslav comes from combining:

- **strict engine invariants**,
- **golden fixture migration reproduction**,
- **realistic behavioral smoke coverage**, and
- **Journal 3 startup-gate coverage** over both pre-Journal and already-Journal fixtures.

That combination is what makes migration changes safer than relying on only unit tests or only end-to-end tests.
