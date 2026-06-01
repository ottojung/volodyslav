# PR #1335 review 1: implementation plan

## 1. Add dynamic dependency accumulation in `recompute.js`

1. Introduce a small helper that builds a materialized dependency accumulator:
   - `identifiers: NodeIdentifier[]`;
   - `counters: number[]`;
   - `add(identifier, counter)` with de-duplication by `nodeIdentifierToString(identifier)`.
2. After static inputs are pulled and their counters are read, seed the accumulator with the static dependency identifiers and counters.
3. Update the computor `pull` callback:
   - serialize the requested dynamic node key;
   - call `_pullDuringPull(concreteKey, tx)`;
   - look up the dynamic identifier from the same transaction lookup;
   - read the dynamic counter from the transaction batch;
   - append the dynamic dependency to the accumulator;
   - return the nested value to the computor.
4. Replace static-only persistence calls with accumulator-based calls:
   - `ensureReverseDepsIndexed(nodeIdentifier, accumulator.identifiers, batch)`;
   - `ensureMaterialized(nodeIdentifier, accumulator.identifiers, accumulator.counters, batch)`;
   - freshness marking for all accumulated dependency identifiers.
5. Update the old-value counter optimization to compare the persisted inputs record against the accumulated dependency list and counters.

## 2. Acquire static allocation locks in canonical order in `class.js`

1. In `resolveConcreteNode(...)`, collect the output key and any static input keys that do not already have identifiers in the transaction lookup.
2. Sort the collected serialized keys lexicographically.
3. Acquire transaction node locks in that sorted order.
4. Allocate or retrieve identifiers only after the ordered lock acquisition completes.

## 3. Add regression tests

Add tests to `backend/tests/incremental_graph_volatile_consistency.test.js`:

1. `dynamic pull callback dependencies invalidate their parent`:
   - `root` has no static inputs;
   - `root` dynamically pulls `leaf`;
   - assert persisted `root.inputs` includes `leaf` and `leaf.revdeps` includes `root`;
   - invalidate `leaf`, pull `root`, and assert `root` recomputes with the new `leaf` value.
2. `concurrent pulls with shared fresh dependencies in opposite input orders complete`:
   - define `left` with inputs `[a, b]`;
   - define `right` with inputs `[b, a]`;
   - start both pulls concurrently and race against a short timeout;
   - assert both results are returned.

## 4. Documentation

Create these review artifacts:

- `docs/pr1335-review1.md` for feedback verification;
- `docs/pr1335-review1-strat.md` for the principled strategy;
- `docs/pr1335-review1-impl.md` for this implementation plan.

## 5. Checks

Run and iterate until all pass:

1. `npx jest backend/tests/incremental_graph_volatile_consistency.test.js`;
2. `npm test`;
3. `npm run static-analysis`;
4. `npm run build`.
