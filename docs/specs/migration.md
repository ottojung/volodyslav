# Incremental Graph Migration

This database-version migration accepts a supported source state produced by the
journal-enabled lifecycle and constructs a supported target state at the next
application version. Both states satisfy the journal
[persistent-state boundary](../incremental-graph-journal.md#persistent-state-boundary),
and the transition preserves the journal invariants specified below.

This document describes the **migration system** for upgrading incremental-graph database state between application versions.

> Note: this migration flow always performs a replica cutover on success. Even
> when node values appear unchanged, migrations still bump `meta/version`, so
> there is no no-op replica-switch optimization in the migration path.

## Overview

When the application version changes, any computed values stored in the previous version's namespace may become stale or structurally incompatible with the new schema.  The migration system provides a strict, fail-fast API—`MigrationStorage`—that lets migration authors:

* **read** source-version values,
* **decide** what happens to each source materialized node (keep, override, invalidate, or delete),
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
| `keep(nodeIdentifier)` | Preserve the cached semantic value, freshness, and timestamps in the new version. Validity proofs follow the proof-retention and hardening rules below. |
| `override(nodeIdentifier, value, targetState)` | Rewrite an existing semantic value into the persistence-safe representation returned by `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`). The migration author certifies semantic equivalence; `isEqual` is not consulted. `targetState` is exactly `"up-to-date"`, `"stale-soft"`, or `"stale-hard"`. The semantic occurrence timestamp is preserved and no decision is propagated to dependents. |
| `invalidate(nodeIdentifier)` | Preserve the cached value while marking the node for recomputation. |
| `delete(nodeIdentifier)` | Remove the node from the new version entirely. |
| `create(nodeKeyString, value, cacheState)` | Create a new cached node (not in the previous version) in the new schema with the result of `value(nodeIdentifier)` (a `NodeIdentifier => Promise<ComputedValue>`) as its initial value. `cacheState` is exactly one of the closed variants below. `nodeKeyString` is a `NodeKeyString` — the semantic key by which the node will be identified in the new schema. A fresh `NodeIdentifier` is allocated automatically. |

`cacheState` makes the cache assertion and its proof requirements distinct:

```text
{ state: "up-to-date" }
{ state: "stale-soft",
  proof: { inputs: [{ nodeKeyString: NodeKeyString, value: ComputedValue }, ...] } }
{ state: "stale-hard" }
```

An up-to-date create asserts a clean computed value. A stale-soft create asserts
that the cached derived value was computed from the exact input values in
`proof.inputs`. Each proof entry identifies its input by canonical semantic
`NodeKeyString`, never by a target `NodeIdentifier`. After the callback has
finished and all migration decisions have been collected, finalization derives
the created node's distinct direct semantic input keys from the new graph
scheme. `proof.inputs` MUST contain exactly one entry for every such key and no
entry for any other key; repeated entries for the same canonical key are
duplicates and invalid.

Finalization builds the planned target `NodeKeyString` to `NodeIdentifier`
lookup from every surviving source node and every `create` decision, then resolves
each required proof key through that lookup. Each key MUST resolve to a target
materialization, and that materialization's final value (after applying its
`keep`, `override`, `invalidate`, or `create` decision) MUST be `isEqual` to the
value supplied in the proof entry. An `invalidate` decision preserves that final
cached value while removing the input materialization's own incoming proofs; its
outgoing proof to the created node remains valid. Only after all of these checks
succeed does migration install an incoming validity edge from each internally
resolved target identifier to the created node. Callback order, allocator
behavior, and callback-visible side effects are not part of proof identity or
resolution. This establishes the complete reusable incoming validity proof even
when one created node depends on another created node or on a stale input whose
cached semantic value is unchanged.

A stale-soft envelope is invalid for a zero-input node, so every zero-input
stale create is necessarily stale-hard. A stale-hard create asserts
must-recompute state and carries no reusable incoming proof.

An override target state is a closed assertion about the rewritten node in the
target schema:

* `"up-to-date"` establishes the complete incoming validity relation for the
  node's actual target-schema inputs. Every input must be materialized and
  up-to-date.
* `"stale-soft"` marks the node potentially outdated while establishing the
  complete reusable incoming proof for its actual target-schema inputs. It is
  invalid for a zero-input node.
* `"stale-hard"` marks the node potentially outdated and establishes no
  incoming proof, so recomputation is required.

These assertions rebuild incoming validity from the target graph scheme rather
than copying edge positions from the source scheme. Consequently an override
can adapt a node from `A -> B` to `C -> B`: the obsolete `A ⇝ B` edge is
removed and an up-to-date or stale-soft target establishes `C ⇝ B`. Missing
target inputs, stale inputs required by an up-to-date target, and impossible
zero-input stale-soft targets produce `InvalidMigrationDecisionError`.

Missing or unknown variants, extra fields, a proof on a variant that does not
accept one, a missing or duplicate proof input key, an extra input key, an
unresolved or non-materialized input key, or a non-`isEqual` final input value throws
`InvalidMigrationDecisionError`. Validation completes before the create mutates
the target replica.

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

`keep` preserves the value, freshness, timestamps, and — for up-to-date nodes — compatible incoming validity. When a stale node carried through `keep` has incoming proofs before migration and migration drops them, the `proofs present before → proofs absent after` transition newly establishes hard invalidation. Migration MUST atomically author a normal generation-scoped hard invalidate unless a barrier authored or installed by that exact migration decision already represents it. The event takes the next local sequence and its `causalContext` covers the supported source authority used to decide hardening.

Within a stale `keep` region whose nodes still have incoming proofs,
those proofs may disappear. A stale B whose dependent C is also stale can lose
both `A⇝B` and `B⇝C` during migration, and both newly hardened nodes must
recompute.

Already-settled hard invalidation is different. If a stale node's incoming
proofs are already absent and an outstanding retained invalidate already
represents the obligation, a `keep` that makes no new proof-
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

`override` is a representation transformation of an existing semantic value.
The migration author certifies that the produced value represents the same
semantic occurrence even when its JSON or schema representation differs and
`isEqual` would return false. Migration neither invokes `isEqual` for admission
nor classifies author intent from the produced representation. Override authors
no `add`, `edit`, validation, or invalidation journal action; preserves the
semantic occurrence's `createdAt` and `modifiedAt`; and does not create or
propagate decisions for dependents. Its explicit target state alone determines
freshness and incoming proof construction in the target graph. Existing
outgoing proof survives when it is still a target structural edge because the
input's semantic occurrence is unchanged.

`invalidate` preserves the cached value if it exists, marks nodes as `"potentially-outdated"`, and preserves `modifiedAt`.

**Explicit invalidation** removes only the explicitly named node's incoming validity proofs. Its outgoing proofs remain intact because its stored semantic value has not changed.

Migration explicit invalidation deliberately reasserts the obligation and
authors a fresh causal invalidate even when the node was already stale, its
incoming proofs were already absent, and an older outstanding invalidate
exists. `create(..., { state: "stale-soft", proof })` authors a new generation
plus soft invalidate after establishing the complete reusable incoming proof.
`create(..., { state: "stale-hard" })` authors a new generation plus hard
invalidate and installs no incoming proof.
These entries use no migration-specific action and follow normal allocation,
atomicity, frontier, iterator, and compaction rules.

**Propagated invalidation** (automatic recursive propagation) preserves all validity proofs — both incoming and outgoing. It is freshness-only: downstream nodes are marked stale but retain their complete proof sets.

`create(..., { state: "up-to-date" })` is a clean-cache assertion and authors
generation(add)+initial validate after validation. The stale-soft and stale-hard
variants author generation(add)+exactly one initial soft or hard invalidate
respectively.

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
| `InvalidMigrationDecisionError` | A produced value is not persistence-safe, or a `create` cache-state/proof is malformed, incomplete, duplicate, extra, unresolved, or inconsistent with its final target inputs. |
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

Migration carries journal entries, `resetAnchorCuts`, `journalCoverage`,
`localJournalCounter`, `causalSummary`, and the durable `DatabaseFingerprint`
into the target without renumbering or changing cut-summary coordinates. A
migration decision that legitimately authors events advances journal, local
counter, local coverage, and causal summary only through the ordinary atomic
authoring rule. It
accepts supported uncompacted state and does not implicitly compact. Durable
tokens preserve meaning across cutover and restart.

Migration validates every cut summary's canonical `(NodeKey,taggedAnchor)` and
`absorbsThrough` shape. The transition retains all source journal entries and
adds only the events required by its decisions in the migration transition
table; those authored events do not alter existing `resetAnchorCuts`.

The migration transition table governs journal changes. Every new generation
includes exactly one later same-author initial freshness assertion. Local
authoring takes the next local sequence, carries source authority relevant to
the decision in `causalContext`, and advances only local coverage/counter.
`keep`, invalidation, and `override` preserve `modifiedAt`; override changes only
the persisted representation and its explicitly selected graph cache state.
Graph, journal, reset-anchor cut summaries,
counter, coverage, causal summary, and durable fingerprint commit
atomically. Migration never seeds graph authority from iterator notifications. Detailed rules are in
`docs/specs/incremental-graph-journal-migrations.md`.

## Atomicity guarantee

Decisions are collected in memory during the callback.  The desired state is unified into the target replica's storage, then validated with `assertValidFinalMergeState` before the replica pointer is switched.  A failed migration never activates the target replica.  Failures before unification leave the target replica untouched.  Failures after unification may leave the inactive replica written, but the active replica remains unchanged.
