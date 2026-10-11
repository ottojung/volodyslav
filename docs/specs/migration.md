# Incremental Graph Migration

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

> Note: this migration flow always performs a replica cutover on success. Even
> when node values appear unchanged, migrations still bump `meta/version`, so
> there is no no-op replica-switch optimization in the migration path.

## Overview

When the application version changes, any computed values stored in the previous version's namespace may become stale or structurally incompatible with the new schema.  The migration system provides a strict, fail-fast API—`MigrationStorage`—that lets migration authors:

* **read** old values,
* **decide** what happens to each previously-materialized node (keep, replace, invalidate, or delete),
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

### Source-to-target NodeKey representation

Every transition is declared with one directed source-to-target **format codec**
(`docs/specs/incremental-graph-journal-migrations.md` §9a), which may declare two
transforms and defaults an omitted one to the identity transform:

```text
rewriteNodeKey(sourceKey) -> NodeKey
rewriteComputedValue(sourceKey, payload) -> ComputedValue
```

Both are synchronous and deterministic and receive no database handle, clock,
randomness, allocator or other replica-local capability. `rewriteNodeKey` changes
representation only: its result denotes the same historical semantic node under the
target version.

The cutover applies the codec twice, and both applications must agree:

* every retained Journal record is rewritten — its own node key, every `NodeKey`
  embedded in a `ValidationBasis` or a `proof` invalidation scope, and every
  `ValueEvent` payload. `JournalRecordId`, writer sequence, context, `AuthorityTime`,
  `NodeIdentifier` and both value timestamps are preserved, and a rewritten
  `ValidationBasis` is re-sorted into the target's canonical `NodeKeyString` order.
  The current-occurrence index, which is keyed by node key, is re-keyed;
* the target replica's `identifiers_keys_map` maps every preserved `NodeIdentifier`
  to the transported target key.

The callback then works in that target key space. `get`, `has` and the traversal
helpers still address the previous replica, so they expose source-representation
data; every decision on an existing materialization resolves its source key `Ks` and
reasons about `Kt = rewriteNodeKey(Ks)`. A representation rename `Ks -> Kt` can
therefore use `keep(id(Ks))` even when `Ks` is absent from the target schema, provided
`Kt` is target-compatible. `create(nodeKeyString, ...)` accepts a target-representation
key and throws `CreateExistingNodeError` when it equals `rewriteNodeKey(Ks)` of any
materialized source node.

A codec which is not total over the retained history, a transform which throws or
returns a non-representation, and a rewrite which this replica observes mapping two
distinct source keys onto one target key all fail
`JournalVersionCompatibilityError` before the cutover.

---

## `MigrationStorage` API

All methods are `async`.

### Decision methods

| Method | Description |
|--------|-------------|
| `get(nodeIdentifier)` | Return the previous-version value. |
| `keep(nodeIdentifier)` | Preserve node as-is in the new version. |
| `replace(nodeIdentifier, value)` | Replace an existing materialized node's semantic value with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`). Preserves the node's `NodeIdentifier` and `createdAt`, and authors a new `ValueEvent` so the new occurrence has its own `ValueId`. |
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

Calling the same decision twice (except for `replace` and `create`) is allowed and has no effect.

### Conflict detection

* Calling **different** decisions on the same node throws `DecisionConflictError`.
* Calling `replace()` more than once on the same node throws `DecisionConflictError`.
* Calling `create()` twice on the same node throws `DecisionConflictError`.
* Calling `create()` on a target key which equals `rewriteNodeKey(Ks)` of a
  materialized source node, or on a target key another `create` already took, throws
  `CreateExistingNodeError`.

### Schema compatibility

`keep`, `replace`, `invalidate`, and `create` check that the node's target key's
functor and arity exist in the new schema.  Incompatible nodes must be explicitly
`delete`d.  Violation throws `SchemaCompatibilityError`.

### Operation semantics

`keep` preserves the value, timestamps, and the incoming validity edges whose source occurrence survives under the occurrence-provenance rule of `docs/specs/incremental-graph-journal-migrations.md` §11a.4. An edge is carried only when its input's occurrence is preserved, the edge existed under the source schema, and the source replica persisted it. A stale occurrence keeps those unaffected edges too: staleness alone does not discard otherwise-valid proof, and only the node's freshness flag records it.

A preserved dependent whose required input occurrence changed — because that input was `replace`d or `create`d — drops that edge and is target-stale, because no legacy replica ever validated the combination. A stale `keep` therefore still recomputes when it is later pulled, but it is recomputation from a stale flag rather than from a missing proof.

An occurrence-preserving decision is target-fresh only when its source occurrence had no surviving direct stale state, every required target input edge is carried, and every target input is target-fresh; otherwise it is target-stale.

`replace` is a **genuine semantic value replacement** of an already-materialized node. It does not propagate invalidation — a replaced node's dependents keep their own decisions and their freshness is derived from the replaced occurrence through replay — but it authors a new occurrence, so an incoming proof edge which named the replaced occurrence is not carried forward. This follows `docs/specs/incremental-graph-journal-migrations.md` §11a.4: a preserved dependent whose required input occurrence changed is hard stale unless the dependent is itself explicitly created or replaced. A representation-only change of the same semantic value is not `replace`; it is the canonical whole-history format codec plus `keep`.

A replaced node takes the migration publication time as its `modifiedAt`, keeps its existing `createdAt`, and is itself up-to-date exactly when every direct target input it selected is up-to-date.

`invalidate` preserves the cached value if it exists, marks nodes as `"potentially-outdated"`, and preserves `modifiedAt`.

**Explicit invalidation** removes only the explicitly named node's incoming validity proofs. Its outgoing proofs remain intact because its stored semantic value has not changed. Because the migrated graph persists the node as `"potentially-outdated"` while the retained certificates which named its occurrence are now ineligible, the cutover also authors one `InvalidateEvent` with `scope={kind:"node"}` and `reason="migration"` at the node's target key, so replay derives the same staleness the graph persists.

**Explicit invalidation assigns no decision to any dependent.** A kept dependent stays materialized and becomes stale through its stale input during replay; the migration does not assign it a propagated invalidation decision and does not conflict merely because it is explicitly kept. Replay derives the dependent's staleness through the invalidated input, so the migration authors no record for the dependent.

`create(..., "up-to-date")` is a clean-cache assertion. The migration validates this assertion before writing the migrated state.
`create(..., "potentially-outdated")` seeds a cached value without claiming it is clean.

### Propagation rules

#### INVALIDATE assigns no dependent decision

An explicit invalidation is a node-scoped semantic decision about exactly the named node. It assigns no decision to any dependent; a dependent must be explicitly decided and becomes stale through its stale input during replay.

#### DELETE → propagate DELETE downstream (deferred, dependency-closed)

DELETE propagation runs at finalization (after the callback returns), via a BFS over dependents. One deleted input is sufficient to delete an undecided dependent, and that deletion propagates through every transitive materialized dependent.

This preserves the materialization invariant that every materialized node has all of its concrete inputs materialized. If a dependent already has an explicit `KEEP`, `REPLACE`, or `INVALIDATE` decision, `DecisionConflictError` is thrown.

---

## Canonical Journal migration chain

Per-edge codec determinism is not enough when a replica can reach the same
target version through different version paths. Immutable retained records
keep their `JournalRecordId`, so every supported upgrade from one Journal
version to another MUST have one canonical transition sequence.

For every supported non-current Journal version `v`, the release lineage
defines at most one:

```text
canonicalNextJournalVersion(v)
```

A supported migration from stored version `v0` to running version `vn`
follows exactly:

```text
v0 -> v1 -> ... -> vn
where vi+1 = canonicalNextJournalVersion(vi)
```

until `vn` is reached. If the complete chain is not available, that source
version is unsupported and startup fails `JournalVersionCompatibilityError`.

A machine may skip application releases, but it does **not** skip canonical
Journal migration transitions. Each chain step is a complete Journal-aware
migration: whole-history codec rewrite, semantic repair, replay validation,
and version cut to that intermediate version.

Once a canonical successor edge has been used for supported Journal history,
later releases which still claim support for that source version preserve
**both the edge and its migration semantics**.

---

## Error types

| Error class | When thrown |
|-------------|------------|
| `DecisionConflictError` | Two different decisions assigned to the same node. |
| `CreateExistingNodeError` | `create()` called for a target key which equals the transported target key of a materialized previous-version node. |
| `UndecidedNodesError` | Some nodes in `S` have no decision after the callback. |
| `SchemaCompatibilityError` | `keep`/`replace`/`invalidate`/`create` on a node absent from the new schema. |
| `InvalidMigrationDecisionError` | A decision which asserts proof or freshness the migration cannot establish, or a decision whose produced state cannot be derived. |
| `GetMissingNodeError` | `get()`/traversal called for a node not in `S`. |
| `MissingDependencyMetadataError` | A materialized node has missing or corrupted dependency metadata. |
| `JournalVersionCompatibilityError` | The transition's format codec is not a valid codec definition, is not total over the retained history, or is observed to map two distinct source node keys onto one target key; or a stored Journal version has no complete canonical migration chain to the running version. |

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

## Atomicity guarantee

Decisions are collected in memory during the callback.  The desired state is unified into the target replica's storage, then validated with `assertValidFinalMergeState` before the replica pointer is switched.  A failed migration never activates the target replica.  Failures before unification leave the target replica untouched.  Failures after unification may leave the inactive replica written, but the active replica remains unchanged.
