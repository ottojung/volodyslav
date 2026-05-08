# Plan: implement internal node identifiers for IncrementalGraph

This plan describes the concrete implementation work needed to realize the design in
`docs/specs/keys-design.md`, and the more general transition from `NodeKey`-based
storage to `NodeIdentifier`-based storage in IncrementalGraph.

## 1. Identifier type and validity

Introduce a nominal `NodeIdentifier` type that defines the persisted identifier format
in one place and enforces it consistently.

- [ ] Add a `NodeIdentifier` nominal type module modeled on the existing `backend/src/event/id.js`, except that it must use `variableName` function for generating random identifiers.
- [ ] Define construction and parsing around the exact full-string validity rule from the design: `/^[a-z_][a-z0-9_]*$/`
- [ ] Reject invalid identifiers during construction, parsing, and before persistence, including explicit rejection of any string that does not match the entire validity rule

## 2. Database shape and lookup metadata

Extend the root database so graph state is identifier-addressed and the semantic
`NodeKey` remains recoverable through explicit lookup tables.

- [ ] Extend incremental-graph database typings with `NodeIdentifier` and identifier-based dependency payloads
- [ ] Add lookup table at `/meta/identifiers_keys_map` (stores an object of type `Array<[NodeIdentifier, NodeKey]>`)
- [ ] Add helper methods `nodeKeyToId` and `nodeIdToKey` to `root_database.js`
- [ ] Ensure the lookup table represents a bijection and is written atomically with graph-state lifecycle changes. Any drift between the cache and the durable storage should be handled in a fail-fast style: eg when a new key couldn't be added to the durable storage, this should prompt a failure to add it to the cache.
- [ ] Load the full bijection into RAM at database open time and maintain it as an in-memory cache; all `NodeKey ↔ NodeIdentifier` lookups go through this cache rather than direct database reads.
- [ ] The cache should be stored in a two-way hashmap structure for efficient lookups in both directions, and should be the authoritative source for the bijection while the database is open.
- [ ] Expand batch builder type to include `metaIdentifiers` operations so identifier allocation/removal can commit in the same physical batch as graph-state updates.
  - [ ] Add integration tests for failure injection: if a batch write fails, neither state sublevels nor lookup metadata should advance.

## 3. Storage boundary and lifecycle behavior

Keep the public graph-facing API keyed by `NodeKey`, while moving all persisted graph
state and graph-to-graph references to `NodeIdentifier`.

- [ ] Refactor `graph_storage.js` so graph-state sublevels are keyed by `NodeIdentifier`, not `NodeKeyString`
- [ ] Add atomic helper(s) to resolve or allocate an identifier for a `NodeKeyString`
- [ ] Keep `IncrementalGraph` and `Interface` APIs unchanged by translating `NodeKey` ↔ `NodeIdentifier` at the storage boundary; `NodeKey` must not appear in any internal storage logic beyond this translation step
- [ ] Update `inputs` and `revdeps` persistence so all stored references are `NodeIdentifier[]`
  - [ ] When rewriting `inputs`, preserve original input order so `inputs[i]` still corresponds to `inputCounters[i]`; only translate each element from `NodeKeyString` to `NodeIdentifier` without reordering.
- [ ] Preserve deterministic revdeps ordering by sorting `NodeIdentifier` values in ascending lexicographic order (do not consult `NodeKey` for ordering)
  - Replace comparator plumbing with `compareNodeIdentifier(a, b)` implemented as string lexical compare on validated ID strings.
  - Update all revdeps materialization points (`graph_storage`, `migration_runner`, `database/sync_merge.js`, topo/unification where relevant) to enforce this order.
  - Add invariant tests: inserting dependencies in random order yields persisted revdeps sorted by identifier lexical order.
- [ ] Update `listMaterializedNodes()` and inspection helpers to map stored ids back to public node keys
- [ ] Update invalidation and recompute paths to reuse existing identifiers and never allocate duplicates
- [ ] Update deletion paths so deleting a node removes both lookup entries and all identifier-keyed state
- [ ] Old APIs must no longer be supported, and all their legacy burden (eg key-path transforms, key-based storage, key-based rendering) must be removed. The only place `NodeKey` should be used is in the public graph API and the bijection lookup table. Do not preserve any backwards compatibility at all, anywhere.

## 4. Migration behavior

Preserve the current migration callback surface while making the persisted data
identifier-addressed and keeping identifier stability where required by the design.

- [ ] Update migration code so migration callbacks become `NodeIdentifier`-based
- [ ] Preserve node identifiers across `keep`, `override`, and `invalidate` migration decisions
- [ ] Allocate fresh identifiers for migration `create`
- [ ] Remove both lookup entries and all identifier-keyed state for migration `delete`

Then, write a single migration that will migrate the database from `NodeKey`-based storage to `NodeIdentifier`-based one.
This requires stepping of the existing migration API, just for this one migration.

## 5. HTTP inspection API

Refactor the internal HTTP inspection surface so concrete-node addressing matches the
identifier-addressed storage model directly.

- [ ] Change the HTTP inspection API so concrete-node operations address nodes by `NodeIdentifier`, not by `head/args`
- [ ] Update the HTTP graph API spec, route shapes, handlers, and tests to the identifier-based concrete-node model
  - [ ] Replace concrete-node `head/args` routes (`/graph/nodes/:head`, `/graph/nodes/:head/*` and the matching POST/DELETE handlers) with identifier-addressed concrete-node routes so handlers no longer parse concrete args from URL path segments. Keep `/graph/schemas` endpoints head-based.
- [ ] Keep the schema-oriented HTTP endpoints aligned with the public graph model where they are still head-based rather than concrete-node based

## 6. Filesystem snapshot simplification

Simplify snapshot rendering and scanning around direct identifier paths, with readable
lookup tables carrying the `NodeKey ↔ NodeIdentifier` relationship.

- [ ] Change render/scan so graph-state paths are direct identifier paths like `rendered/r/values/nodeid1`
- [ ] Keep lookup metadata readable and separate in the snapshot format (at `/meta/identifiers_keys_map`)
- [ ] Remove the concrete-node path encoding/decoding model entirely
- [ ] Delete any code whose job is converting concrete node keys to filesystem paths or back
- [ ] Simplify `database/encoding.js`, render helpers, scan helpers, and unification helpers around the direct identifier-path snapshot format

This requires careful audit to avoid leaving hidden key-path transforms.

## 7. Tests and documentation

Update the documentation and focused tests so the new identifier-addressed model is
fully specified and regression-protected.

- [ ] Update docs and tests that currently assert raw `NodeKeyString` storage in `inputs`, `revdeps`, rendering, migration, and unification
- [ ] Add focused tests for identifier allocation, lookup bijection, stable id reuse, migration preservation, identifier-based HTTP inspection, and snapshot round-tripping
