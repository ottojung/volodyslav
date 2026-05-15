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

Make `NodeIdentifier` the normal concrete-node address for IncrementalGraph operations.
`NodeKey` remains semantic identity and the explicit lookup input to `nodeKeyToId(nodeKey)`.
If a caller starts with a `NodeKey`, it must resolve `id = nodeKeyToId(nodeKey)` first and
then run concrete-node operations by identifier.

- [ ] Refactor `graph_storage.js` so graph-state sublevels are keyed by `NodeIdentifier`, not `NodeKeyString`
- [ ] Refactor `incremental_graph/class.js` so that all of `IncrementalGraph` methods accept (and return) `NodeIdentifier`, not `NodeKeyString`. The `NodeKeyString` must not even be imported into that module.
- [ ] Add two methods to `IncrementalGraph` public interface:
  - [ ] `nodeKeyToId`
  - [ ] `nodeIdToKey`
- [ ] Make all internal logic work on `NodeIdentifier` instead of `NodeKey`. Including, but not limited to:
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
- [ ] Old key-addressed concrete-node APIs must be removed once identifier-based paths exist. Remove key-path transforms, key-based storage helpers, and key-based rendering helpers. Outside schema/head APIs and the explicit lookup bridge (`nodeKeyToId` / `nodeIdToKey`), concrete-node operations must not be `NodeKey`-addressed.

## 4. Migration behavior

Replace (not preserve) the current `NodeKey`-addressed migration callback surface with a fully `NodeIdentifier`-addressed one, while keeping identifier stability where required by the design.

- [ ] Update migration code so **all migration callbacks and migration-internal graph references** are `NodeIdentifier`-based (no `NodeKey`-addressed migration inputs/outputs anywhere)
  - [ ] Port `migration_storage.js` helpers and decision signatures to identifiers end-to-end (`readInputsRecord`, `readDependents`, `Decision` callback params, and `materializedNodes/decisions` collections). Leaving any of these as `NodeKeyString` will silently keep `inputs`/`revdeps` and propagation logic key-addressed even after callback APIs are switched.
  - [ ] Keep migration decisions (`keep`/`delete`/`override`/`invalidate`/`create`) `NodeIdentifier`-addressed, but add an explicit lookup helper for callbacks that need schema/head-based selection (current `migration.js` does `deserializeNodeKey(nodeKey).head` in `keepNodeType`/`deleteNodeType`). Without this helper, porting the existing migration callback will either break head-based filtering or incorrectly reintroduce `NodeKey`-addressed decision APIs.
  - [ ] Preserve global lookup metadata during migration-source projection, not only `global/version`.
    - Current `migration_runner.js` lazy source hardcodes `global.keys()` to yield only `version`; if left unchanged, `unifyStores` will delete `/${inactive_replica}/global/identifiers_keys_map` during migration because it is absent from the source view.
    - Update lazy migration source global handling to pass through all required global keys, including `identifiers_keys_map`, while still overriding `version` to the target app version.
    - Ensure copy semantics are explicit: non-version global keys should come from previous storage unless migration logic intentionally rewrites them.
    - Add a regression test that seeds previous replica `global` with both `version` and `identifiers_keys_map`, runs migration, and asserts the inactive replica retains the identifiers map after unify + cutover.
    - Add a regression test that runs migration where callbacks do not touch lookup metadata and verifies no accidental deletion of `identifiers_keys_map` occurs.
- [ ] Preserve node identifiers across `keep`, `override`, and `invalidate` migration decisions
- [ ] Allocate fresh identifiers for migration `create`
- [ ] Remove both lookup entries and all identifier-keyed state for migration `delete`

Then, write a single migration that will migrate the database from `NodeKey`-based storage to `NodeIdentifier`-based one.
For this one-time legacy `NodeKey` -> `NodeIdentifier` migration, identifiers must be deterministic from the old `NodeKey` (still conform to `[a-z]*` regex of `basicString(length=9)`). To achieve this, set a fixed `seed` for the random generator, and then from that seed, generate all the `basicString(length=9)` values.
This requires changing the existing migration API for all future migrations so the migration surface is consistently `NodeIdentifier`-based; do not keep a mixed `NodeKey`/`NodeIdentifier` migration mode, even temporarily.

## 5. HTTP inspection API

Refactor the internal HTTP inspection surface so concrete-node addressing matches the
identifier-addressed storage model directly.

- [ ] Change the HTTP inspection API so concrete-node operations address nodes by `NodeIdentifier`, not by `head/args`
- [ ] Update the HTTP graph API spec, route shapes, handlers, and tests to the identifier-based concrete-node model
  - [ ] Replace concrete-node `head/args` routes (`/graph/nodes/:head`, `/graph/nodes/:head/*` and the matching POST/DELETE handlers) with identifier-addressed concrete-node routes, and remove all URL-arg decoding logic tied to concrete-node addressing.
    - Current handlers rely on wildcard path parsing (`req.params[0]`) plus `getArgsFromRequest()` in `backend/src/routes/graph_helpers.js` to recover `ConstValue[]` from URL segments (including encoded `/` and `~`-prefixed non-strings). If this helper path is left in place after route migration, identifier endpoints can accidentally continue treating identifiers as split arg vectors or apply JSON-ish decoding to IDs.
    - Define explicit concrete-node routes that take one opaque identifier segment (for example `GET/POST/DELETE /graph/nodes/id/:nodeIdentifier`) and ensure handlers call identifier-based interface methods directly rather than reconstructing `(head, args)` from the URL.
    - Keep schema endpoints head-based (`/graph/schemas`, `/graph/schemas/:head`) and do not route them through identifier parsing.
    - Update route registration order/comments in `backend/src/routes/graph.js`: wildcard-first ordering is currently required only for `:head/*`; once identifier routes are used, preserve only the ordering constraints that still apply.
    - Replace route tests that currently assert head/args parsing behavior (including encoded slash and `~` decoding cases) with identifier-focused tests that assert identifiers are passed through as opaque strings and never decoded as `ConstValue` arguments.
  - [ ] Update list/read response payloads so concrete-node records returned by HTTP inspection are identifier-addressed, not `(head,args)`-addressed.
    - Current `GET /graph/nodes` and `GET /graph/nodes/:head` handlers in `backend/src/routes/graph.js` enumerate materialized nodes from `interface.listMaterializedNodes()` and emit `{ id, head, args, freshness, ... }` objects. After route migration, this payload shape leaves clients unable to call identifier-addressed pull/delete/invalidate endpoints without recomputing keys.
    - Introduce interface/inspection methods that can enumerate concrete nodes by `NodeIdentifier` (with freshness/value/timestamps), and have HTTP handlers read from those methods directly instead of re-keying from `(head,args)`.
    - Keep any schema-oriented responses head-based, but require concrete-node response objects (lists and single-node reads) to carry `nodeIdentifier` as the addressing field used by follow-up concrete-node operations.
    - Update `backend/tests/graph_routes.test.js` assertions to reject legacy concrete-node payloads that omit `nodeIdentifier` and to verify round-trip workflow (`list` → `GET/POST/DELETE by id`) without any `head/args` URL construction.
    - Add at least one regression test for encoded-looking identifiers to prove response-to-route flow treats identifiers as opaque and never applies argument-decoding semantics.
- [ ] Keep the schema-oriented HTTP endpoints aligned with the public graph model where they are still head-based rather than concrete-node based

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
- [ ] Add focused tests for identifier allocation, lookup bijection, stable id reuse, migration preservation, identifier-based HTTP inspection, and snapshot round-tripping
