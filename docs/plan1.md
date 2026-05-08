# Plan: implement internal node identifiers for IncrementalGraph

This plan describes the concrete implementation work needed to realize the design in
`docs/spec/keys-design.md`.

## 1. Identifier type and validity

Introduce a nominal `NodeIdentifier` type that defines the persisted identifier format
in one place and enforces it consistently.

- [ ] Add a `NodeIdentifier` nominal type module modeled on the existing `backend/src/event/id.js`
- [ ] Define construction and parsing around the exact full-string validity rule from the design: `/^[a-z_][a-z0-9_]*$/`
- [ ] Reject invalid identifiers during construction, parsing, and before persistence, including explicit rejection of any string that does not match the entire validity rule
- [ ] Delete `backend/src/random/string.js` and its test `backend/tests/random_string.test.js`
- [ ] Add `backend/src/random/variable_name.js` that generates identifiers matching `/^[a-z_][a-z0-9_]*$/` using the repository's capabilities-driven seed pattern
- [ ] Export `variableName` from `backend/src/random/index.js` (removing the `string` export)
- [ ] Migrate every existing caller of `random.string` (`backend/src/event/id.js`, `backend/src/runtime_identifier.js`) to use `random.variableName` instead

## 2. Database shape and lookup metadata

Extend the root database so graph state is identifier-addressed and the semantic
`NodeKey` remains recoverable through explicit lookup tables.

- [ ] Extend incremental-graph database typings with `NodeIdentifier` and identifier-based dependency payloads
- [ ] Add lookup sublevels `node_key_to_id` and `node_id_to_key` to `root_database.js`
- [ ] Ensure the lookup sublevels represent a bijection and are written atomically with graph-state lifecycle changes
- [ ] Load the full bijection into RAM at database open time and maintain it as an in-memory cache; all `NodeKey ↔ NodeIdentifier` lookups go through this cache rather than direct database reads

## 3. Storage boundary and lifecycle behavior

Keep the public graph-facing API keyed by `NodeKey`, while moving all persisted graph
state and graph-to-graph references to `NodeIdentifier`.

- [ ] Refactor `graph_storage.js` so graph-state sublevels are keyed by `NodeIdentifier`, not `NodeKeyString`
- [ ] Add atomic helper(s) to resolve or allocate an identifier for a `NodeKeyString`
- [ ] Keep `IncrementalGraph` and `Interface` APIs unchanged by translating `NodeKey` ↔ `NodeIdentifier` at the storage boundary; `NodeKey` must not appear in any internal storage logic beyond this translation step
- [ ] Update `inputs` and `revdeps` persistence so all stored references are `NodeIdentifier[]`
- [ ] Preserve deterministic revdeps ordering by sorting `NodeIdentifier` values in ascending lexicographic order (do not consult `NodeKey` for ordering)
- [ ] Update `listMaterializedNodes()` and inspection helpers to map stored ids back to public node keys
- [ ] Update invalidation and recompute paths to reuse existing identifiers and never allocate duplicates
- [ ] Update deletion paths so deleting a node removes both lookup entries and all identifier-keyed state

## 4. Migration behavior

Preserve the current migration callback surface while making the persisted data
identifier-addressed and keeping identifier stability where required by the design.

- [ ] Update migration code so migration callbacks remain `NodeKey`-based while stored results become identifier-based
- [ ] Preserve node identifiers across `keep`, `override`, and `invalidate` migration decisions
- [ ] Allocate fresh identifiers for migration `create`
- [ ] Remove both lookup entries and all identifier-keyed state for migration `delete`

## 5. HTTP inspection API

Refactor the internal HTTP inspection surface so concrete-node addressing matches the
identifier-addressed storage model directly.

- [ ] Change the HTTP inspection API so concrete-node operations address nodes by `NodeIdentifier`, not by `head/args`
- [ ] Update the HTTP graph API spec, route shapes, handlers, and tests to the identifier-based concrete-node model
- [ ] Keep the schema-oriented HTTP endpoints aligned with the public graph model where they are still head-based rather than concrete-node based

## 6. Filesystem snapshot simplification

Simplify snapshot rendering and scanning around direct identifier paths, with readable
lookup tables carrying the `NodeKey ↔ NodeIdentifier` relationship.

- [ ] Change render/scan so graph-state paths are direct identifier paths like `rendered/r/values/nodeid1`
- [ ] Keep lookup metadata readable and separate in the snapshot format
- [ ] Remove the concrete-node path encoding/decoding model entirely
- [ ] Delete any code whose job is converting concrete node keys to filesystem paths or back
- [ ] Simplify `database/encoding.js`, render helpers, scan helpers, and unification helpers around the direct identifier-path snapshot format

## 7. Tests and documentation

Update the documentation and focused tests so the new identifier-addressed model is
fully specified and regression-protected.

- [ ] Update docs and tests that currently assert raw `NodeKeyString` storage in `inputs`, `revdeps`, rendering, migration, and unification
- [ ] Add focused tests for identifier allocation, lookup bijection, stable id reuse, migration preservation, identifier-based HTTP inspection, and snapshot round-tripping
