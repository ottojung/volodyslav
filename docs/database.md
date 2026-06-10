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
| `freshness` | Whether a node is `up-to-date` or `potentially-outdated` |
| `inputs`    | Input dependency list for each node                       |
| `revdeps`   | Reverse-dependency index (input → list of dependents)     |
| `counters`  | Monotonic integer tracking how many times a value changed |
| `timestamps`| Creation and last-modification ISO timestamps             |
| `meta`      | Namespace metadata (currently just the schema version)    |

There is also a top-level `_meta` sublevel (outside the `x`/`y` namespace) that stores the database
current replica pointer.

### Key format

Node keys are JSON-serialised objects of the form `{"head":"<name>","args":[...]}`, for example:

```
{"head":"all_events","args":[]}
{"head":"event","args":["abc123"]}
{"head":"transcription","args":["/path/to/audio.mp3"]}
```

At the raw LevelDB level these are concatenated with the sublevel prefixes, e.g.

```
!x!!values!{"head":"all_events","args":[]}
!x!!freshness!{"head":"all_events","args":[]}
!_meta!current_replica
```

---

## Filesystem rendering (paired snapshot)

The database exposes two complementary operations for rendering its state into a paired
snapshot directory and restoring it from a snapshot:

```js
const { renderToFilesystem, scanFromFilesystem } = require('./database');

// Render sublevel "x" into a paired snapshot rooted at /path/to/snapshot
await renderToFilesystem(capabilities, rootDatabase, '/path/to/snapshot', 'x');

// Scan snapshot sublevel "x" back into database sublevel "x"
await scanFromFilesystem(capabilities, rootDatabase, '/path/to/snapshot', 'x');
```

The snapshot root is the directory that directly contains the sibling managed trees:

```
snapshotRoot/
  kindtree/        ← schema files (one per value root)
  rendered/        ← primitive leaf files (zero or more per value root)
```

The compatibility entrypoints (`renderToFilesystem` / `scanFromFilesystem`) use the same
sublevel name for both the database sublevel and the snapshot sublevel. When the source and
snapshot sublevel names differ, use the explicit API:

```js
renderSublevelToSnapshot(capabilities, rootDatabase, {
    snapshotRoot,
    sourceSublevel,   // database sublevel to render
    snapshotSublevel, // sublevel under kindtree/ and rendered/
});

scanSublevelFromSnapshot(capabilities, rootDatabase, {
    snapshotRoot,
    targetSublevel,   // database sublevel to write into
    snapshotSublevel, // sublevel under kindtree/ and rendered/
});
```

### Key → file-path mapping

Each raw LevelDB key is translated to a *relative file path* inside the snapshot directory.
The algorithm depends on the key type:

#### Data sublevels (`values`, `freshness`, `inputs`, `revdeps`, `counters`, `timestamps`)

The stored key is a JSON-serialised NodeKey object `{"head":"...","args":[...]}`.
It is decomposed into human-readable path segments:

```
!x!!values!{"head":"all_events","args":[]}
  → x/values/all_events

!x!!values!{"head":"event","args":["abc123"]}
  → x/values/event/abc123

!x!!values!{"head":"transcription","args":["/audio/x.mp3"]}
  → x/values/transcription/%2Faudio%2Fx.mp3
```

String arguments are percent-encoded: `/` → `%2F`, `%` → `%25`, `!` → `%21`.
Literal dot-segment path components `.` and `..` are encoded as `%2E` and `%2E%2E`
to prevent path traversal while keeping the key↔path mapping bijective. Non-string arguments
(numbers, booleans, arrays, objects) are JSON-encoded and prefixed with `~` so they remain
unambiguous even when string arguments begin with `~`.

#### Meta sublevels (`_meta`, `meta`)

The stored key is a plain string (e.g. `format`, `version`).
It is used as a single percent-encoded path segment:

```
!_meta!current_replica    → _meta/current_replica
!x!!meta!version → x/meta/version
```

### File-path → key mapping (inverse)

`relativePathToKey` is the exact inverse of `keyToRelativePath`:

1. **Determine sublevel depth**: if the first segment is `_meta` → depth 1; otherwise depth 2.
2. **Extract sublevels**: first `depth` segments.
3. **Determine key type**: if the last sublevel is `_meta` or `meta` → plain string; otherwise NodeKey.
4. **Reconstruct key**:
   - Plain string: decode the single remaining segment and reassemble the LevelDB key.
   - NodeKey: first remaining segment is the node head; subsequent segments are decoded arguments;
     reassemble using `serializeNodeKey({head, args})` and build the LevelDB key.

### Bijection guarantee

For all keys generated by this database the mapping `key → path → key` is an exact bijection:

```
relativePathToKey(keyToRelativePath(key)) === key   // for all valid keys
```

The `!` character in argument values is encoded as `%21` before splitting, so it can never be
mistaken for the LevelDB sublevel separator.

### Reconciliation and value reconstruction

The paired snapshot scanner (`scanFromFilesystem` / `scanSublevelFromSnapshot`) is schema-led:
it enumerates `kindtree/`, validates and parses schemas, claims rendered leaves, and reconstructs
complete values before any database mutation. Unclaimed rendered files (present in `rendered/` but
not referenced by any schema in `kindtree/`) cause a hard failure with `ExtraRenderedFileError`.

The renderer (`renderToFilesystem` / `renderSublevelToSnapshot`) writes both the type schema
under `kindtree/` and zero-or-more primitive leaf files under `rendered/` for each value root.

### Empty snapshot semantics

The snapshot root directory is the unit of snapshot existence:

- If `snapshotRoot` does not exist at scan time, scanning fails before any database
  mutation with `ScanInputDirMissingError`. A missing root is not an empty snapshot.
- If `snapshotRoot` exists but is empty, scanning treats it as a valid empty
  database snapshot and empties the target sublevel during reconciliation.
- If `snapshotRoot` exists but contains neither `kindtree/<snapshotSublevel>` nor
  `rendered/<snapshotSublevel>`, that is a valid empty snapshot for that sublevel.
- Empty snapshots require no child files or directories below the root.
- Rendering an empty sublevel produces an existing empty snapshot root:
  the root directory exists but `kindtree/` and `rendered/` subtrees are absent
  (pruned by the renderer).

Legacy rendered-only partial snapshots (rendered files without matching schemas)
remain invalid and are rejected with `MissingKindtreeRootError`.

### No locking

Neither `renderToFilesystem` nor `scanFromFilesystem` acquires any lock.  Callers that require
atomicity must arrange their own locking around these calls.

### No locking

Neither `renderToFilesystem` nor `scanFromFilesystem` acquires any lock.  Callers that require
atomicity must arrange their own locking around these calls.

---

## Checkpointing and synchronisation

The live LevelDB now lives outside the git repository
(`<workingDirectory>/generators-leveldb/`). The git repository stores a paired
filesystem snapshot under `<workingDirectory>/generators-database/` with sibling
`kindtree/` and `rendered/` directories.
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
  only if the merge introduced graph changes (`take`/`invalidate` decisions).
  Pure no-op merges keep the active replica pointer unchanged.

See [`docs/gitstore.md`](./gitstore.md) for the gitstore primitives that back these operations.
