# Plan: introduce internal node identifiers for IncrementalGraph

- [ ] Add a `NodeIdentifier` nominal type module modeled on `backend/src/event/id.js`
- [ ] Extend incremental-graph database typings with `NodeIdentifier` and identifier-based dependency payloads
- [ ] Add lookup sublevels `node_key_to_id` and `node_id_to_key` to `root_database.js`
- [ ] Refactor `graph_storage.js` so graph-state sublevels are keyed by `NodeIdentifier`, not `NodeKeyString`
- [ ] Add atomic helper(s) to resolve or allocate an identifier for a `NodeKeyString`
- [ ] Keep `IncrementalGraph` and `Interface` APIs unchanged by translating `NodeKey` ↔ `NodeIdentifier` at the storage boundary
- [ ] Update `inputs` and `revdeps` persistence so all stored references are `NodeIdentifier[]`
- [ ] Preserve deterministic revdeps ordering by sorting identifiers according to their mapped `NodeKey`
- [ ] Update `listMaterializedNodes()` and inspection helpers to map stored ids back to public node keys
- [ ] Update invalidation/recompute paths to reuse existing identifiers and never allocate duplicates
- [ ] Update deletion paths so deleting a node removes both lookup entries and all identifier-keyed state
- [ ] Update migration code so migration callbacks remain `NodeKey`-based while stored results become identifier-based
- [ ] Preserve node identifiers across `keep` / `override` / `invalidate` migration decisions and allocate fresh ids for `create`
- [ ] Update filesystem rendering and scanning (`database/encoding.js`, render/unification helpers, docs/tests) so graph-state paths use identifiers and lookup sublevels preserve readability
- [ ] Update tests that currently assert raw `NodeKeyString` storage in `inputs`, `revdeps`, rendering, migration, and unification
- [ ] Add focused tests for identifier allocation, lookup bijection, stable id reuse, migration preservation, and snapshot round-tripping
