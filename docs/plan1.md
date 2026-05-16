# Plan: implement internal node identifiers for IncrementalGraph

This plan describes the concrete implementation work needed to realize the design in
`docs/specs/keys-design.md`, and the more general transition from `NodeKey`-based
storage to `NodeIdentifier`-based storage in IncrementalGraph.

## 1. Identifier type and validity

Introduce a nominal `NodeIdentifier` type that defines the persisted identifier format
in one place and enforces it consistently.

- [ ] Add a `NodeIdentifier` nominal type module modeled on the existing `backend/src/event/id.js`, except that it must use `basicString(length=9)` function for generating random identifiers.
- [ ] Define construction and parsing around the exact full-string validity rule from the design: `/^[a-z]*$/`
- [ ] Reject invalid identifiers during construction, parsing, and before persistence, including explicit rejection of any string that does not match the entire validity rule

## 2. Database shape and lookup metadata

Modify the root database so that graph state is identifier-addressed instead of `NodeKey` adressed.
The semantic `NodeKey` should remain recoverable through explicit lookup tables.

- [ ] Switch incremental-graph database typings to `NodeIdentifier` and identifier-based dependency payloads
- [ ] Add lookup table at `/${current_replica}/global/identifiers_keys_map` (stores an object of type `Array<[NodeIdentifier, NodeKey]>`)
  - Here `${current_replica}` is the replica name of the current database instance, for example `x` or `y`.
- [ ] Add helper methods `nodeKeyToId` and `nodeIdToKey` to `root_database.js`
- [ ] Ensure the lookup table represents a bijection and is written atomically with graph-state lifecycle changes. Any drift between the cache and the durable storage should be handled in a fail-fast style: eg when a new key couldn't be added to the durable storage, this should prompt a failure to add it to the cache.
- [ ] Load the full bijection into RAM at database open time and maintain it as an in-memory cache; all `NodeKey ↔ NodeIdentifier` lookups go through this cache rather than direct database reads.
  - [ ] Scope cache ownership to replica-specific storage, not to process-global state. `RootDatabase` keeps both `x` and `y` schema storages live and switches between them via `_meta/current_replica`; cache state must follow the selected replica exactly.
  - [ ] On `switchToReplica(...)`, ensure every lookup path (`getSchemaStorage()`, `schemaStorageForReplica(...)`, and graph storage wrappers) reads the cache bound to that replica. Never reuse the old active replica cache after pointer cutover.
  - [ ] On `clearReplicaStorage(...)` / schema rebuild, drop and reconstruct that replica's bijection cache from durable `global/identifiers_keys_map` before any reads. Reusing pre-clear cache entries would resurrect deleted ids.
  - [ ] Keep cache lifecycle symmetric across normal runtime and migration runtime: migration writes to inactive replica storage before cutover, so inactive-replica cache must be updated from the same batch writes that mutate `values|inputs|revdeps|...`.
  - [ ] Add focused tests that (1) seed different identifier maps in `x` and `y`, switch replicas, and assert lookups switch maps immediately; and (2) clear a replica, repopulate it, and assert old cache entries are impossible to read.
- [ ] The cache should be stored in a two-way hashmap structure for efficient lookups in both directions, and should be the authoritative source for the bijection while the database is open.
- [ ] Make identifier allocation explicitly collision-safe at the storage boundary (`nodeKeyToId` path), not just "random enough":
  - [ ] Allocation must retry when a generated `NodeIdentifier` already exists in `id -> key` mapping, and must only commit once a truly unused identifier is found.
  - [ ] On collision, the pre-existing mapping must remain unchanged; never overwrite `nodeIdToKey(existingId)` or "steal" an identifier from another node.
  - [ ] If repeated collisions prevent allocation from finding a free id within a bounded retry budget, fail with a dedicated storage error instead of silently writing an inconsistent map.
  - [ ] Add a focused test that stubs identifier generation to return a duplicate id first, then a fresh id, and asserts the second id is the one persisted for the new node.
  - [ ] Add a focused test that forces persistent collisions and asserts no partial writes to either direction of the bijection or any graph-state sublevels.
- [ ] Expand batch builder type to include `metaIdentifiers` operations so identifier allocation/removal can commit in the same physical batch as graph-state updates.
  - [ ] Add integration tests for failure injection: if a batch write fails, neither state sublevels nor lookup metadata should advance.
- [ ] Update every schema-storage adapter to carry the identifiers map as first-class replica data, not as an out-of-band special case.
  - [ ] Extend `database/root_database.js` `SchemaStorage` and `buildSchemaStorage()` with a typed store for `identifiers_keys_map`, and ensure it is present for both active and inactive replicas.
  - [ ] Mirror the same typed store in `database/hostname_storage.js`; migration/sync code uses hostname-backed storages and will silently drop lookup metadata unless this path is updated too.
  - [ ] Update `database/unification/db_to_db.js` so `identifiers_keys_map` participates in copy/unify operations; otherwise sync can copy `inputs`/`revdeps` that reference ids absent from the destination lookup table.
  - [ ] Add focused tests that perform sync/unification between replicas and assert both directions of the bijection survive, not just graph-state sublevels.
- [ ] Always serialize `identifiers_keys_map` sorted by `NodeIdentifier`.
- [ ] Add eager fail-fast bijection validation primitives and run them before every graph merge/sync/unification operation.
  - [ ] Validate the full `NodeIdentifier ↔ NodeKey` mapping as a strict bijection (no duplicate ids, no duplicate keys, no malformed ids, no malformed keys) before reading merge inputs.
  - [ ] Reject any state where one `NodeKey` maps to multiple `NodeIdentifier` values (or vice versa) so semantic-node identity cannot split across identifiers.
  - [ ] Fail immediately if graph-state sublevels (`values`, `inputs`, `revdeps`, `counters`, `timestamps`, `freshness`) reference identifiers absent from the bijection.
  - [ ] Fail immediately if any merge input references a semantic node key that resolves to a different identifier on the two sides of a merge operation.
  - [ ] Treat validation failures as hard sync errors (no best-effort repair, no partial writes, no fallback merge path), because proceeding can create duplicate semantic nodes, incorrect timestamp winner selection, and stale edge sets.
  - [ ] Add targeted tests that intentionally construct identifier/key divergence across replicas and assert merge aborts before topo-sort, timestamp arbitration, or revdeps rebuild.

## 3. Storage boundary and lifecycle behavior

`IncrementalGraph` is the conversion boundary.

- Public graph-facing APIs remain semantic-key based (`NodeKey` and existing `head + args` forms).
- At the public method boundary (`pull`, `invalidate`, `unsafePull`, `unsafeInvalidate`, `getValue`, `getFreshness`, timestamp/inspection helpers), convert immediately to `NodeIdentifier`.
- After this conversion point, all internals (storage, recompute, invalidation propagation, migration/sync/render/scan interactions) must use `NodeIdentifier` only.

- [ ] Keep public `IncrementalGraph` concrete-node API signatures `NodeKey`/`head+args` based (`pull`, `invalidate`, `unsafePull`, `unsafeInvalidate`, `getValue`, `getFreshness`, timestamp helpers, inspection helpers)
- [ ] Keep `listMaterializedNodes()` as a semantic API returning `[head, args]`, even after storage keys become `NodeIdentifier`
  - [ ] Update `inspection.js` + `graph_storage.js` boundary so materialization listing reads identifier-keyed materialized records, translates each id through `nodeIdToKey`, then deserializes to existing `[head, args]` route-facing output.
  - [ ] Treat missing/invalid bijection entries during this translation as hard errors (fail-fast), not as silently skipped nodes; otherwise `/graph/nodes` can hide durable corruption.
  - [ ] Add a regression test for `/graph/nodes` and `listMaterializedNodes()` proving no caller-visible `NodeIdentifier` leakage and stable pre-migration response shape.
- [ ] Refactor `incremental_graph/class.js` internals so conversion from `NodeKey`/`head+args` to `NodeIdentifier` happens immediately at method entry before storage/internal calls
  - [ ] Add focused tests that assert public methods still accept `head + args` and do not require callers to resolve ids first
  - [ ] Add focused tests that verify internal calls below the boundary are `NodeIdentifier`-only (no `NodeKeyString` passed into storage/migration/sync helpers)
- [ ] Remove the remaining `NodeKeyString`-addressed graph methods from the public class surface in `incremental_graph/class.js` (`pullByNodeKeyStringWithStatus`, `pullByNodeKeyStringWithStatusDuringPull`)
  - [ ] Replace them with **NodeIdentifier-addressed** internal helpers for recompute/pull recursion (for example in `pull.js`); do not keep `NodeKeyString`-addressed recursion helpers after boundary conversion, or internal pull paths will silently violate the identifier-native invariant.
  - [ ] Update `recompute.js` capability typing to depend on identifier-native/internal helper calls instead of public `NodeKeyString` class methods.
  - [ ] Add a regression test that public graph-facing routes and interface flows still work, while no public `NodeKeyString`-addressed concrete-node entrypoints remain exposed on the graph object.
- [ ] Keep `nodeKeyToId` / `nodeIdToKey` as lower-level translation helpers (storage/internal boundary), not public `IncrementalGraph` methods
  - [ ] Place them in storage/database-facing helper modules used by `IncrementalGraph` internals and migration/sync/render paths
  - [ ] Add tests that guard against re-introducing `graph.nodeKeyToId(...)` / `graph.nodeIdToKey(...)` on the public interface
- [ ] Refactor `graph_storage.js` so graph-state sublevels are keyed by `NodeIdentifier`, not `NodeKeyString`
- [ ] Make all internal logic below the boundary use `NodeIdentifier` instead of `NodeKey`. Including, but not limited to:
  - [ ] Update `inputs` and `revdeps` persistence so all stored references are `NodeIdentifier[]`
    - [ ] When rewriting `inputs`, preserve original input order so `inputs[i]` still corresponds to `inputCounters[i]`; only translate each element from `NodeKeyString` to `NodeIdentifier` without reordering.
  - [ ] Preserve deterministic revdeps ordering by sorting `NodeIdentifier` values in ascending lexicographic order (do not consult `NodeKey` for ordering)
    - Replace comparator plumbing with `compareNodeIdentifier(a, b)` implemented as string lexical compare on validated ID strings.
    - Update all revdeps materialization points (`graph_storage`, `migration_runner`, `database/sync_merge.js`, topo/unification where relevant) to enforce this order.
    - Update topological ordering tie-breakers (`database/topo_sort.js` and merge logic in `database/sync_merge.js`) to compare `NodeIdentifier` lexically, otherwise migration/sync decisions can remain `NodeKey`-ordered even after revdeps are identifier-ordered.
    - Add invariant tests: inserting dependencies in random order yields persisted revdeps sorted by identifier lexical order.
- [ ] Add sync-merge preconditions that must hold before timestamp arbitration runs.
  - [ ] In `database/sync_merge.js`, perform eager validation that semantic equality is computed from `NodeKey` via the bijection and is never inferred from raw `NodeIdentifier` equality alone.
  - [ ] Abort merge if the same semantic `NodeKey` appears under two different identifiers across T/H inputs, instead of mechanically treating them as distinct nodes.
  - [ ] Abort merge if two identifiers in one side resolve to the same semantic `NodeKey`.
  - [ ] Ensure merged-input-map construction, topo ordering, and revdeps rebuild run only after the above validation succeeds.
- [ ] Update invalidation and recompute paths to reuse existing identifiers and never allocate duplicates
- [ ] Update deletion paths so deleting a node removes both lookup entries and all identifier-keyed state
- [ ] Remove legacy key-based concrete-node storage internals after boundary conversion is in place. Outside public API entrypoints and semantic-schema helpers, concrete-node operations must not be `NodeKey`-addressed.
## 4. Migration behavior

Replace (not preserve) the current `NodeKey`-addressed migration callback surface with a fully `NodeIdentifier`-addressed one, while keeping identifier stability where required by the design.

- [ ] Update migration code so **all migration callbacks and migration-internal graph references** are `NodeIdentifier`-based (no `NodeKey`-addressed migration inputs/outputs anywhere)
  - [ ] Port `migration_storage.js` helpers and decision signatures to identifiers end-to-end (`readInputsRecord`, `readDependents`, `Decision` callback params, and `materializedNodes/decisions` collections). Leaving any of these as `NodeKeyString` will silently keep `inputs`/`revdeps` and propagation logic key-addressed even after callback APIs are switched.
  - [ ] Keep migration decisions (`keep`/`delete`/`override`/`invalidate`/`create`) `NodeIdentifier`-addressed, but add an explicit lookup helper for callbacks that need schema/head-based selection (current `migration.js` does `deserializeNodeKey(nodeKey).head` in `keepNodeType`/`deleteNodeType`). Without this helper, porting the existing migration callback will either break head-based filtering or incorrectly reintroduce `NodeKey`-addressed decision APIs.
  - [ ] Preserve global lookup metadata during migration-source projection, not only `global/version`.
    - Current `backend/src/generators/incremental_graph/migration_runner.js` lazy source (`makeLazyMigrationSource`) hardcodes `global.keys()` to yield only `version`; if left unchanged, `unifyStores` will delete `/${inactive_replica}/global/identifiers_keys_map` during migration because it is absent from the source view.
    - Update lazy migration source global handling to pass through all required global keys, including `identifiers_keys_map`, while still overriding `version` to the target app version.
    - Ensure copy semantics are explicit: non-version global keys should come from previous storage unless migration logic intentionally rewrites them.
    - Add a regression test that seeds previous replica `global` with both `version` and `identifiers_keys_map`, runs migration, and asserts the inactive replica retains the identifiers map after unify + cutover.
    - Add a regression test that runs migration where callbacks do not touch lookup metadata and verifies no accidental deletion of `identifiers_keys_map` occurs.
- [ ] Preserve node identifiers across `keep`, `override`, and `invalidate` migration decisions
- [ ] Allocate fresh identifiers for migration `create`
- [ ] Remove both lookup entries and all identifier-keyed state for migration `delete`

Then, write a single migration that will migrate the database from `NodeKey`-based storage to `NodeIdentifier`-based one.
For this one-time legacy `NodeKey` -> `NodeIdentifier` migration, identifiers must be deterministic from the old `NodeKey` (still conform to `[a-z]*` regex of `basicString(length=9)`), **and must not depend on traversal order**.
- [ ] Do **not** use a single global fixed-seed generator consumed in iteration order; migration traversal order can change (for example, by key enumeration or topology tie-break differences), which would remap stable nodes to different identifiers across runs.
- [ ] Instead, derive each legacy node’s candidate identifier from that node’s own `NodeKey` in an order-independent way (for example: key-derived deterministic PRNG seed or hash-to-identifier mapping), then resolve rare collisions with a deterministic per-key retry sequence.
- [ ] Add a regression test that runs the legacy migration from the same source data under two different node-iteration orders and asserts the resulting `identifiers_keys_map` is identical.
This requires changing the existing migration API for all future migrations so the migration surface is consistently `NodeIdentifier`-based; do not keep a mixed `NodeKey`/`NodeIdentifier` migration mode, even temporarily.

## 5. HTTP inspection API

Keep the HTTP graph API compatible with the existing public graph model.
Concrete-node routes stay `head + args` addressed, while handler internals convert to
`NodeIdentifier` at the same `IncrementalGraph` boundary.

- [ ] Keep HTTP concrete-node routes `head/args` based (`/graph/nodes/:head`, `/graph/nodes/:head/*`, and matching POST/DELETE flows)
- [ ] Do **not** introduce identifier-addressed public concrete-node routes such as `/graph/nodes/id/:nodeIdentifier`
- [ ] Keep request parsing behavior in `backend/src/routes/graph.js` and `graph_helpers.js` aligned with current head/args semantics
- [ ] Add regression tests that protect against accidental identifier leakage into HTTP API:
  - [ ] round-trip workflows remain `list/read/pull/invalidate` via `head + args`
  - [ ] responses do not require caller-visible `NodeIdentifier` for follow-up operations
  - [ ] encoded arg parsing behavior remains intact where currently supported
- [ ] Add integration tests that prove HTTP handlers can stay head/args-facing while graph internals execute identifier-native storage paths after boundary conversion
## 6. Filesystem snapshot simplification

Simplify snapshot rendering and scanning around direct identifier paths, with readable
lookup tables carrying the `NodeKey ↔ NodeIdentifier` relationship.

- [ ] Change render/scan so graph-state paths are direct identifier paths like `rendered/r/values/nodeid1`
- [ ] Keep lookup metadata readable and separate in the snapshot format (at `/${current_replica}/global/identifiers_keys_map`)
- [ ] Remove the concrete-node path encoding/decoding model entirely
- [ ] Delete any code whose job is converting concrete node keys to filesystem paths or back
- [ ] Simplify `database/encoding.js`, render helpers, scan helpers, and unification helpers around the direct identifier-path snapshot format
  - [ ] In `database/encoding.js`, remove the NodeKey JSON path contract for data sublevels: `keyToRelativePath()` and `relativePathToKey()` must treat `values|freshness|inputs|revdeps|counters|timestamps` keys as single identifier segments (`.../<id>`), not `head/arg...` expansions.
  - [ ] Remove `serializeNodeKey` / `deserializeNodeKey` usage from graph-state path encoding/decoding; after this change those conversions are only allowed for reading/writing `/${current_replica}/global/identifiers_keys_map`, not for graph-state files.
  - [ ] Update `backend/tests/database_render.test.js` cases that currently enforce “expected NodeKey JSON” for data sublevels; those assertions become wrong once keys are opaque identifiers and will otherwise force accidental reintroduction of NodeKey-based path decoding.
  - [ ] Add a render/scan regression test that seeds raw keys like `!x!!values!nodeid1` + `!x!!inputs!nodeid1`, verifies rendered files are `rendered/x/values/nodeid1` / `rendered/x/inputs/nodeid1`, and round-trips back without any `head`/`args` directories.
  - [ ] Update synchronization/git checkpoint helpers that currently hardcode NodeKey-based rendered paths.
    - [ ] Migrate `renderedKeyPath()` expectations in `backend/tests/database_synchronize.test.js` from `.../values/<head>/<arg...>` to direct identifier paths `.../values/<id>`.
    - [ ] Migrate the same helper expectations in `backend/tests/database_gitstore.test.js`; this suite asserts tracked commit-tree paths and will otherwise keep forcing legacy head/args directories.
    - [ ] Audit any `renderedKeyPath`-style test utilities under `backend/tests/` that call `keyToRelativePath` and still document node-key-style path segments.
  - [ ] Add one end-to-end sync/checkpoint assertion that starts from identifier-keyed raw DB entries (for example `!x!!values!nodeid1`) and verifies all of the following together:
    - [ ] render/synchronize writes git snapshot files at identifier paths,
    - [ ] scan/synchronize imports those files back into raw keys unchanged, and
    - [ ] no path in the rendered tree introduces `/<head>/` or extra arg segments for graph-state sublevels.
  - [ ] Keep the top-level replica/sublevel layout unchanged (`rendered/x/...`, `rendered/y/...`, `rendered/_meta/...`); only concrete-node key segments become opaque identifiers.
    - [ ] Add/adjust one assertion in synchronize-related tests that still checks the top-level directory contract so key-shape migration does not accidentally mutate replica routing semantics.

This requires careful audit to avoid leaving hidden key-path transforms.

## 7. Tests and documentation

Update the documentation and focused tests so the new identifier-addressed model is
fully specified and regression-protected.

- [ ] Update docs and tests that currently assert raw `NodeKeyString` storage in `inputs`, `revdeps`, rendering, migration, and unification
- [ ] Add focused tests for identifier allocation, lookup bijection, stable id reuse, migration preservation, head+args HTTP API boundary protections, identifier-native internals validation, and snapshot round-tripping
