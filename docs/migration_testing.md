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

Conceptually, migration must preserve these invariants:

- **No partial cutover**: users either stay on old state or atomically switch to fully migrated state.
- **Deterministic graph structure**: especially revdeps ordering and topology-sensitive structures.
- **Decision completeness**: every materialized old node must receive exactly one migration decision.
- **Failure isolation**: failed attempts must not corrupt the active replica.

The migration test suite is organized to prove these invariants from different angles.

---

## Layer 1 — migration runner and storage unit/integration tests

The core engine is tested directly via `runMigration`, plus supporting storage logic.

### What these tests are trying to prove

The tests in `backend/tests/migration_runner.test.js`, `backend/tests/migration_storage.test.js`, and related focused files (`migration_runner_timestamps`, `migration_revdeps_ordering`) collectively validate:

- migration gate behavior (fresh DB, already-current DB, version mismatch),
- checkpoint boundaries (pre/post migration commits),
- callback/finalization failure semantics,
- replica-switch ordering guarantees,
- x-replica preservation on failure,
- metadata/version write rules,
- deterministic revdeps output,
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
3. Initialize interface and trigger synchronization (which runs migration when needed).
4. Clone the resulting remote branch.
5. Compare its rendered database directory against the canonical “current populated” fixture.

### Why exact directory comparison is powerful

This test acts like a golden-output test for migration. Instead of asserting many tiny fields, it verifies the complete rendered shape produced by migration. That gives high confidence that:

- migrated keys and values match expected representation,
- rendered materialization is stable,
- migration side effects are not accidentally omitted.

It also remains reasonably robust because it compares canonical fixture directories rather than low-level LevelDB internals.

---

## Layer 3 — smoke test that exercises the migrated repository

File: `backend/tests/populated_incremental_database_remote_smoke.test.js`.

This is the behavioral smoke test over a realistic populated fixture. It ensures the repository is not just structurally migrated, but also **operationally healthy** through the public interface.

### What this smoke test covers

After bootstrapping from fixture-backed remote state, it exercises:

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

1. Run focused migration protocol tests first (`migration_runner`, `migration_storage`, revdeps/timestamps).
2. Run fixture migration equivalence test.
3. Run populated remote smoke test.
4. Only then run broader test suites.

If a migration change is intentional and alters canonical rendered output, update fixtures deliberately and explain why in the change description.

---

## Summary

Migration confidence in Volodyslav comes from combining:

- **strict engine invariants**,
- **golden fixture migration reproduction**, and
- **realistic behavioral smoke coverage**.

That combination is what makes migration changes safer than relying on only unit tests or only end-to-end tests.
