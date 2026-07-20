# Database

The `incremental_graph/database` module wraps a [LevelDB](https://github.com/Level/level) instance
and exposes it as a typed, namespace-scoped key–value store for the incremental graph engine.

---

## Conceptual overview

### Namespaces (x / y)

Every key is stored inside a *namespace sublevel* – currently `x` (live data) or `y` (staging
namespace used during schema migrations).  At the LevelDB level this means all keys are prefixed
with `!x!` or `!y!`.  Callers never deal with these prefixes directly; the `RootDatabase` class
encapsulates them.

### Sub-sublevels

Within each namespace there are further typed sublevels:

| Sublevel    | Purpose                                                   |
|-------------|-----------------------------------------------------------|
| `values`    | The computed output value for each graph node             |
| `freshness` | Total materialized-node freshness table: `potentially-outdated` or `up-to-date` |
| `valid`     | Inverse validity relation for cached values (input → validated cached consumers) |
| `timestamps`| Total materialized-node timestamp table (`createdAt` identity creation, `modifiedAt` value version) |
| `global`    | Namespace metadata (version, identifiers_keys_map materialized-node registry, last_node_index, fingerprint, graph_scheme) |

Structural dependency edges (`inputEdges(N)`) are not persisted per node. They are derived from
`global/graph_scheme` (the schema's input-position definitions), `global/identifiers_keys_map`
(the semantic-key-to-identifier bijection), and the node's own semantic key. The resulting
`NodeIdentifier[]` is computed at runtime and used for validity checking. Because the
graph scheme defines the dependency shape centrally, per-node input storage is unnecessary.

There is also a top-level `_meta` sublevel (outside the `x`/`y` namespace) that stores the database
current replica pointer.

### Key format

Data sublevels (`values` cached value storage, `freshness`, `valid`, `timestamps`) are
keyed by **NodeIdentifier** — an opaque string assigned to each materialised node.
Semantic node keys (`NodeKey` objects: `{"head":"<name>","args":[...]}`) are mapped to
their identifiers through an identifier-lookup table stored under the `IDENTIFIERS_KEY`
in the `global` sublevel.  The relationship between the two addressing schemes is:

- **Public IncrementalGraph APIs** (`pull`, `invalidate`, etc.) accept semantic
  `NodeKey` strings or concrete `NodeKey` descriptors.
- **Storage** is identifier-native: all data sublevel records are keyed by
  `NodeIdentifier`.
- **Migration decisions** (`keep`, `override`, `delete`, `invalidate`, `get`)
  take `NodeIdentifier` values, since migration operates directly on the
  stored graph state.
- **`create(nodeKeyString, value)`** is the special migration case: it
  accepts a semantic `NodeKey` string, allocates a fresh `NodeIdentifier`,
  and stores the new value under that identifier.

At the raw LevelDB level these are concatenated with the sublevel prefixes, e.g.

```
!x!!values!gafdmopql
!x!!freshness!gafdmopql
!_meta!current_replica
```

---

## Filesystem rendering

The database exposes two complementary operations for dumping and restoring its complete state
to/from a plain directory tree:

```js
const { renderToFilesystem, scanFromFilesystem } = require('./database');

// Dump every key/value pair to disk
await renderToFilesystem(capabilities, rootDatabase, '/path/to/snapshot');

// Restore the database from a snapshot (clears all existing entries first)
await scanFromFilesystem(capabilities, rootDatabase, '/path/to/snapshot');
```

### Key → file-path mapping

Each raw LevelDB key is translated to a *relative file path* inside the snapshot directory.
The algorithm depends on the key type:

#### Data sublevels (`values`, `freshness`, `valid`, `timestamps`)

The stored key is a `NodeIdentifier` — an opaque string that identifies a
materialised graph node.  It is emitted as a single encoded path segment:

```
!x!!values!gafdmopql
  → x/values/gafdmopql

!x!!freshness!gafdmopql
  → x/freshness/gafdmopql
```

The key content is percent-encoded for filesystem safety: `/` → `%2F`, `%` → `%25`, `!` → `%21`.
Literal dot-segment path components `.` and `..` are encoded as `%2E` and `%2E%2E`
to prevent path traversal while keeping the key↔path mapping bijective.

#### Meta sublevels (`_meta`, `global`)

The stored key is a plain string (e.g. `format`, `version`).
It is used as a single percent-encoded path segment:

```
!_meta!current_replica    → _meta/current_replica
!x!!global!version → x/global/version
```

### File-path → key mapping (inverse)

`relativePathToKey` is the exact inverse of `keyToRelativePath`:

1. **Determine sublevel depth**: if the first segment is `_meta` → depth 1; otherwise depth 2.
2. **Extract sublevels**: first `depth` segments.
3. **Reconstruct key**: decode the single remaining segment and reassemble the LevelDB key.
   For data sublevels the key is a `NodeIdentifier` (opaque string, not decomposed); for
   meta sublevels it is a plain string.

### Bijection guarantee

For all keys generated by this database the mapping `key → path → key` is an exact bijection:

```
relativePathToKey(keyToRelativePath(key)) === key   // for all valid keys
```

The `!` character in key or path segments is encoded as `%21` before splitting, so it can never be
mistaken for the LevelDB sublevel separator.

### Stale-key deletion (P2)

`scanFromFilesystem` **clears all existing entries** from the database before importing.
This ensures that keys present in the database but absent from the snapshot directory
(i.e., deleted entries) do not survive the restore, preserving the bijection/restore semantics.

### Value serialisation

Values are stored as JSON.  `renderToFilesystem` writes `JSON.stringify(value)` to each file;
`scanFromFilesystem` reads each file and calls `JSON.parse(content)` before writing back to the
database.

### No locking

Neither `renderToFilesystem` nor `scanFromFilesystem` acquires any lock.  Callers that require
atomicity must arrange their own locking around these calls.

---

## Checkpointing and synchronisation

The live LevelDB now lives outside the git repository
(`<workingDirectory>/generators-leveldb/`). The git repository stores a rendered
filesystem snapshot under `<workingDirectory>/generators-database/rendered/`.
Two higher-level operations are available:

- **`checkpointDatabase(capabilities, message, rootDatabase)`** – renders the live
  database into the tracked snapshot directory and commits it (no-op if nothing
  has changed). Used for single rendered snapshots such as sync.
- **`checkpointMigration(capabilities, rootDatabase, preMessage, postMessage, callback)`** –
  wraps the whole migration in one `checkpointSession`, commits the rendered
  snapshot before the migration body runs, executes the migration, then commits
  the rendered post-migration snapshot (no temp clone or push step).
- **`synchronizeNoLock(capabilities, options)`** – renders the current database,
  synchronises the rendered repository with the remote generators repository,
  and then scans the updated rendered snapshot back into the live database.
  During per-host graph merge, this sync path switches `_meta/current_replica`
  only when the final local graph differs from the active source replica, such as
  imported host materializations, target materialization deletions, surviving
  identifier reconciliation, freshness or validity changes. Pure no-op merges keep
  the active replica pointer unchanged.

See [`docs/gitstore.md`](./gitstore.md) for the gitstore primitives that back these operations.

## Strong invalidation validity semantics

Invalidation revokes validity proofs and therefore implies recomputation before an affected materialized node can become up-to-date again. Freshness records whether a materialized node may return immediately: an `up-to-date` node may return its cached value, while a `potentially-outdated` node pulls its dependencies and invokes its computor with the cached value as `oldValue`.

The `valid` relation is not a stale-cache reuse predicate. An incoming edge `valid[D].has(N)` is a proof required for `N` to be up-to-date. An outgoing set `valid[N]` is the proof frontier consumed by invalidation propagation.

Explicit invalidation of `N` marks `N` potentially-outdated, removes every incoming proof from each structural input into `N`, and consumes `N`'s outgoing validity frontier. Propagated invalidation removes the causal proof or proofs by which invalidation reached the dependent, marks the dependent potentially-outdated, and consumes that dependent's outgoing frontier. In diamonds, edge processing is separate from node expansion, so every causal edge is removed even if a downstream node is expanded only once.

A stale materialized node has no outgoing validity proofs. A stale non-source node lacks at least one incoming structural proof. Synchronization and migration preserve cached values but must not mint replacement proofs for invalidated nodes; their final replicas must satisfy the same strong-invalidation invariants before cutover.
