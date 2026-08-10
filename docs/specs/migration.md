# Incremental Graph Migration

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

> Note: this migration flow always performs a replica cutover on success. Even
> when node values appear unchanged, migrations still bump `meta/version`, so
> there is no no-op replica-switch optimization in the migration path.

## Overview

When the application version changes, any computed values stored in the previous version's namespace may become stale or structurally incompatible with the new schema.  The migration system provides a strict, fail-fast API—`MigrationStorage`—that lets migration authors:

* **read** old values,
* **decide** what happens to each previously-materialized node (keep, override, invalidate, or delete),
* **traverse** the previous version's dependency graph.

A failed migration never activates the target replica.  Failures before unification leave the target replica untouched.  Failures after unification may leave the inactive replica written, but the active replica remains unchanged.

---

## Concepts

### Migration scope `S`

`S` is the set of all nodes materialized in the previous version. A node is materialized if and only if its identifier exists in `identifiers_keys_map`, `values`, `freshness`, and `timestamps`. A fresh node has freshness `"up-to-date"`; a stale node has freshness `"potentially-outdated"`.

After the user-supplied migration callback returns, **every node in `S` must have exactly one decision**.  Missing decisions cause `UndecidedNodesError`.

### Previous-version graph edges

Traversal helpers expose dependency metadata derived from durable graph metadata:

* Dependencies are derived from the stored graph scheme and identifiers lookup.
* `listValidDependents(N)` — nodes in `valid[N]` (outgoing validity frontier).

Traversal never re-executes computors; it derives dependency edges from `global/graph_scheme` and `identifiers_keys_map`.

---

## `MigrationStorage` API

All methods are `async`.

### Decision methods

| Method | Description |
|--------|-------------|
| `get(nodeIdentifier)` | Return the previous-version value. |
| `keep(nodeIdentifier)` | Preserve node as-is in the new version. |
| `override(nodeIdentifier, value)` | Rewrite an existing cached value with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`), while preserving its cache-state proof envelope. |
| `invalidate(nodeIdentifier)` | Mark the node for recomputation. |
| `delete(nodeIdentifier)` | Remove the node from the new version entirely. |
| `create(nodeKeyString, value, freshness)` | Create a new cached node (not in the previous version) in the new schema with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`) as its initial value. `freshness` must be `"up-to-date"` or `"potentially-outdated"`. `nodeKeyString` is a `NodeKeyString` — the semantic key by which the node will be identified in the new schema. A fresh `NodeIdentifier` is allocated automatically. |

### Traversal methods

| Method | Description |
|--------|-------------|
| `has(nodeIdentifier)` | `true` if `nodeIdentifier ∈ S`. |
| `listMaterializedNodes()` | `AsyncIterable<NodeIdentifier>` of all nodes in `S`. |
| Dependency inspection | Derived from the stored graph scheme and identifiers lookup. |
| `listValidDependents(nodeIdentifier)` | Previous-version validity frontier (returns `NodeIdentifier[]`). |
| `resolveNodeKey(nodeIdentifier)` | Resolve a `NodeIdentifier` to the parsed semantic `NodeKey` used by the previous replica, if available. |

---

## Decision rules

### Idempotency

Calling the same decision twice (except for `override` and `create`) is allowed and has no effect.

### Conflict detection

* Calling **different** decisions on the same node throws `DecisionConflictError`.
* Calling `override()` more than once on the same node throws `OverrideConflictError`.
* Calling `create()` twice on the same node throws `DecisionConflictError`.
* Calling `create()` on a node that exists in the previous version throws `CreateExistingNodeError`.

### Schema compatibility

`keep`, `override`, `invalidate`, and `create` check that the node's functor and arity exist in the new schema.  Incompatible nodes must be explicitly `delete`d.  Violation throws `SchemaCompatibilityError`.

### Operation semantics

`keep` preserves the value, freshness, timestamps, and — for up-to-date nodes — compatible incoming validity. When a stale node carried through `keep` has incoming proofs before migration and migration drops them, the `proofs present before → proofs absent after` transition newly establishes hard invalidation. Migration MUST atomically author a normal generation-scoped causal invalidate above all observed journal history unless a barrier authored or installed by that exact migration decision already represents it. The same rule applies to `override`.

Within a stale `keep`/`override` region whose nodes still have incoming proofs,
those proofs may disappear. A stale B whose dependent C is also stale can lose
both `A⇝B` and `B⇝C` during migration, and both newly hardened nodes must
recompute.

Already-settled hard invalidation is different. If a stale node's incoming
proofs are already absent and an outstanding retained invalidate already
represents the obligation, a `keep` or `override` that makes no new proof-
removal or hardening decision carries that state silently. It authors no new
invalidate, allocates no new local index, and advances no journal clock for this
reason. Repeated passive migrations do not manufacture barriers merely because
the node remains stale.

```text
before migration:
    K stale
    incoming proofs absent
    retained invalidate I outstanding

migration.keep(K)

after migration:
    K remains stale
    proofs remain absent
    I still represents the existing obligation
    no new journal entry
```

**Migration-time propagated invalidation** is different: the migration callback explicitly calls `invalidate()` on a node, and the propagation runs in memory with full provenance. In that case outgoing proofs survive and freshness-only propagation preserves validity edges.

`override` is a **semantic-preserving representation rewrite**. It changes the stored representation (e.g. on-disk format) while preserving the semantic value as seen by dependents. Because the value is semantically unchanged, `override()` does not propagate invalidation — it inherits freshness, timestamps, and validity from the old record. The same stale-node rule applies: a stale node carried through `override` loses its incoming proofs.

`override()` MUST NOT be used when the migration changes the meaning or value of a node. If the value itself changes, use `invalidate()` instead, which triggers downstream recomputation so that dependents observe the new value.

The intended use case is format migration: the database version changes the serialization format but the represented value is still meaningfully the same value. In that scenario missing invalidation in `override()` is correct by design — not a bug.

`invalidate` preserves the cached value if it exists, marks nodes as `"potentially-outdated"`, and preserves `modifiedAt`.

**Explicit invalidation** removes only the explicitly named node's incoming validity proofs. Its outgoing proofs remain intact because its stored semantic value has not changed.

Migration explicit invalidation deliberately reasserts the obligation and
authors a fresh causal invalidate even when the node was already stale, its
incoming proofs were already absent, and an older outstanding invalidate
exists. `create(..., "potentially-outdated")` likewise authors a
barrier for its new add generation because it creates a must-recompute cache.
These entries use no migration-specific action and follow normal allocation,
atomicity, frontier, cursor, and compaction rules.

**Propagated invalidation** (automatic recursive propagation) preserves all validity proofs — both incoming and outgoing. It is freshness-only: downstream nodes are marked stale but retain their complete proof sets.

`create(..., "up-to-date")` is a clean-cache assertion. The migration validates this assertion before writing the migrated state.
`create(..., "potentially-outdated")` seeds a cached value without claiming it is clean.

### Propagation rules

#### INVALIDATE → propagate INVALIDATE downstream

When a node is invalidated, all its dependents are automatically marked `INVALIDATE` (recursively), unless they are already `DELETE`d.  If a dependent already has a `KEEP` or `OVERRIDE` decision, `DecisionConflictError` is thrown immediately.

#### DELETE → propagate DELETE downstream (deferred, dependency-closed)

DELETE propagation runs at finalization (after the callback returns), via a BFS over dependents. One deleted input is sufficient to delete an undecided dependent, and that deletion propagates through every transitive materialized dependent.

This preserves the materialization invariant that every materialized node has all of its concrete inputs materialized. If a dependent already has an explicit `KEEP`, `OVERRIDE`, or `INVALIDATE` decision, `DecisionConflictError` is thrown.

---

## Error types

| Error class | When thrown |
|-------------|------------|
| `DecisionConflictError` | Two different decisions assigned to the same node. |
| `OverrideConflictError` | `override()` called more than once on the same node. |
| `CreateExistingNodeError` | `create()` called for a node that already exists in the previous version. |
| `UndecidedNodesError` | Some nodes in `S` have no decision after the callback. |
| `SchemaCompatibilityError` | `keep`/`override`/`invalidate`/`create` on a node absent from the new schema. |
| `InvalidMigrationDecisionError` | `override` or `create` called without the cache-state proof required by its API. |
| `GetMissingNodeError` | `get()`/traversal called for a node not in `S`. |
| `MissingDependencyMetadataError` | A materialized node has missing or corrupted dependency metadata. |

---

## Running a migration

Use `runMigration()` from the `incremental_graph` module:

```js
const { runMigration } = require('./generators/incremental_graph');

await runMigration(rootDatabase, newVersionNodeDefs, async (storage) => {
    for await (const nodeIdentifier of storage.listMaterializedNodes()) {
        // Decide what to do with each node
        if (shouldKeep(nodeIdentifier)) {
            await storage.keep(nodeIdentifier);
        } else {
            await storage.delete(nodeIdentifier);
        }
    }
});
```

`runMigration` will:

1. Detect the previous version by examining stored schema namespaces.
2. Create a `MigrationStorage` backed by the previous version's data.
3. Execute the callback.
4. Call `finalize()` internally (propagate deletes, check completeness).
5. Apply all decisions **atomically** to the new version's storage.

If no previous version is found, the migration is a no-op.

---

## Journal interaction

Migration exact-copies one fixed active receiver snapshot of retained
`StoredJournalEntry` values, their local indexes, `localJournalClock`, and
`localJournalIndexWatermark`. Separately, same-process inactive construction
threads the running receiver's private cursor-domain identity into the target;
the identity is never persisted or read from synchronization state. This
preserves the logical receiver domain across in-process cutover and never
imports remote cursor metadata. A new runtime restoration allocates a new
domain.

Pre-cutover validation requires valid same-key generation references; retained
validation-causal references that resolve, match key/generation/author, and
name an invalidate preceding the validation sequence; logical-clock coverage;
exactly one unique valid index per retained entry; and index-watermark coverage.
Indexes have no logical merge or provenance role; gaps are valid. An
implementation MAY defensively reject visible immutable-ID conflicts,
same-author validation-context regression, or another supported-authoring
violation when enough evidence remains. Those best-effort diagnostics are not
preconditions for a supported migration: compaction may have discarded the
relevant history.

A structurally valid journal produced by supported lifecycle transitions is a
supported migration input whether canonical compaction has run or not.
Migration copies retained entries and local indexes exactly and does not
implicitly compact them. It authors, indexes, or touches only the entries that
the migration's semantic transitions ordinarily require. In particular, a
journal-silent migration preserves all old local indexes and needs no
compaction witness touch. An independently requested compaction is a separate
operation governed by the ordinary compaction cursor-coverage rules.

Migration classifies old/new semantic graph states normally. `create` authors
add with `add.time=createdAt=modifiedAt`; delete and genuine freshness changes
author their ordinary actions. `keep`, `invalidate`, and semantic-preserving
`override` create no value event and preserve `modifiedAt`; representation-only
bytes are not an edit. Each authored entry gets a fresh logical sequence and
local index; a changed key without a newly indexed entry has its greatest
retained witness touched. All graph, journal, index, and allocator changes commit
atomically. Migration never seeds graph authority from journal history.

Detailed rules are in `docs/specs/incremental-graph-journal-migrations.md`.

## Atomicity guarantee

Decisions are collected in memory during the callback.  The desired state is unified into the target replica's storage, then validated with `assertValidFinalMergeState` before the replica pointer is switched.  A failed migration never activates the target replica.  Failures before unification leave the target replica untouched.  Failures after unification may leave the inactive replica written, but the active replica remains unchanged.
