# PR #1335 review 1: feedback verification

This document studies the May 25, 2026 review feedback on PR #1335, "Switch IncrementalGraph persistence and migration to node identifiers", and verifies it against the affected incremental graph implementation.

## Affected implementation

The affected runtime path is:

1. `pull.js` resolves a public or nested pull to `pullNode(...)`.
2. `class.js` turns a concrete node key into a `ResolvedConcreteNode` by resolving the output identifier and static input identifiers.
3. `recompute.js` pulls the static inputs, creates the computor `pull` callback, executes the computor, and persists `inputs` / `revdeps` through `graph_state.js`.
4. `graph_state.js` writes the materialized inputs record and reverse dependency index using node identifiers.

## Feedback item 1: dynamic pulls are not tracked as dependencies

### Feedback

> When a computor uses the new `pull` callback for a dependency that is not in the static `inputs` list, this pulls the nested node but never records its identifier/counter in the parent node's materialized inputs. `ensureMaterialized` later persists only `nodeDefinition.inputIdentifiers`, so `revdeps` has no edge from the dynamically pulled node to the parent; invalidating or changing that nested node leaves the parent marked up-to-date with a stale cached value.

### Verification

This feedback is correct.

Before the fix, `internalMaybeRecalculate` built `currentInputCounters` only while iterating over `nodeDefinition.inputKeys`, i.e. the static inputs known from the schema. The computor's `pull` callback called `_pullDuringPull(...)` and returned the nested value, but it did not record the dynamically pulled node identifier or its counter in any accumulator associated with the parent recomputation.

The later calls to `ensureReverseDepsIndexed(...)` and `ensureMaterialized(...)` used `nodeDefinition.inputIdentifiers` and `currentInputCounters`. Therefore only static dependencies were persisted. A dynamic dependency could be materialized and cached correctly as its own node, but the parent `inputs` record and the reverse dependency index did not include the dynamic edge.

### Consequence

A concrete stale-cache scenario is:

1. `root` has `inputs: []`.
2. `root`'s computor calls `await pull("leaf")`.
3. `root` is persisted with an empty inputs record, and `leaf`'s `revdeps` entry does not contain `root`.
4. `leaf` is invalidated or changes.
5. Invalidation propagation reads `revdeps[leaf]`, finds no `root`, and leaves `root` marked `up-to-date`.
6. A later `pull("root")` returns the stale cached value without recomputing.

## Feedback item 2: dependency locks are acquired in input order

### Feedback

> For fresh concurrent pulls, dependency locks are acquired in each node's input order and held until the transaction finishes. If two nodes share new dependencies in opposite orders, e.g. one schema has inputs `[a, b]` while another has `[b, a]`, one transaction can hold `a` and wait for `b` while the other holds `b` and waits for `a`, deadlocking both pulls. Acquiring all needed locks in a canonical order (or not holding dependency locks across the whole transaction) avoids this.

### Verification

This feedback is correct.

Before the fix, `resolveConcreteNode(...)` acquired the output lock first and then acquired locks for static inputs in `concreteNode.inputs` order only when the input did not already have an identifier in the transaction lookup. Those locks remained held in `tx.nodeLockReleases` until the transaction finished.

Because pull-mode operations are allowed to run concurrently, two transactions for different output nodes could both be active. If the input identifiers were fresh, the transactions could acquire shared dependencies in opposite schema order. For example:

- `left` with inputs `[a, b]` can lock `a` and then wait for `b`.
- `right` with inputs `[b, a]` can lock `b` and then wait for `a`.

That creates a circular wait. The issue is not caused by identifier-native storage; it is caused by multi-lock acquisition in non-canonical order while holding locks until transaction cleanup.

## Documentation clarification needed?

The feedback is not a reviewer misunderstanding; it identifies two real runtime correctness issues. Documentation alone would not be sufficient. The implementation must be changed, and the docs should describe the intended invariants so future reviewers can distinguish correct behavior from incidental behavior:

- Dynamic pulls are materialized dependencies of the currently recomputed parent.
- The parent input record stores both static and dynamic dependency identifiers and the corresponding counters observed after each dependency pull.
- Reverse dependencies must include dynamic edges.
- Any transaction that needs more than one concrete-node lock must acquire those locks in a stable canonical order.
