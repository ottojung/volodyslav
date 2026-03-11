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
format marker.

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
!_meta!format
```

---

## Filesystem rendering

The database exposes two complementary operations for dumping and restoring its complete state
to/from a plain directory tree:

```js
const { renderToFilesystem, scanFromFilesystem } = require('./database');

// Dump every key/value pair to disk
await renderToFilesystem(capabilities, rootDatabase, '/path/to/snapshot');

// Restore the database from a snapshot
await scanFromFilesystem(capabilities, rootDatabase, '/path/to/snapshot');
```

### Key → file-path mapping

Each raw LevelDB key is translated to a *relative file path* inside the snapshot directory.
The algorithm is:

1. **Percent-encode** any `/` characters inside the key as `%2F`, and any `%` characters as `%25`,
   to prevent key-internal slashes from creating unintended directory levels.
2. **Split** the encoded key on `!`, **filter out** empty segments (which arise from the leading
   `!` and from the `!!` separator between nested sublevels).
3. **Join** the remaining segments with `/`.

Examples:

| Raw LevelDB key | Relative file path |
|---|---|
| `!_meta!format` | `_meta/format` |
| `!x!!values!{"head":"all_events","args":[]}` | `x/values/{"head":"all_events","args":[]}` |
| `!x!!values!{"head":"transcription","args":["/audio/x.mp3"]}` | `x/values/{"head":"transcription","args":["%2Faudio%2Fx.mp3"]}` |

### File-path → key mapping (inverse)

`relativePathToKey` is the exact inverse of `keyToRelativePath`:

1. **Split** the relative path on `/`.
2. **Decode** `%2F` → `/` and `%25` → `%` in every segment.
3. **Reassemble** the LevelDB key as `!` + `sublevels.join('!!')` + `!` + `actualKey`, where all
   segments except the last are treated as sublevel names and the last segment is the stored key.

### Bijection guarantee

For all keys created by the LevelDB abstract-level sublevel API (where sublevel names and actual
keys do not themselves contain `!`), the mapping `key → path → key` is an exact bijection:

```
relativePathToKey(keyToRelativePath(key)) === key   // for all valid keys
```

This guarantee is validated by the test suite in `backend/tests/database_render.test.js`.

### Value serialisation

Values are stored as JSON.  `renderToFilesystem` writes `JSON.stringify(value)` to each file;
`scanFromFilesystem` reads each file and calls `JSON.parse(content)` before writing back to the
database.

### No locking

Neither `renderToFilesystem` nor `scanFromFilesystem` acquires any lock.  Callers that require
atomicity must arrange their own locking around these calls.

---

## Checkpointing and synchronisation

The LevelDB files live inside a dedicated local git repository
(`<workingDirectory>/generators-database/`).  Two higher-level operations are available:

- **`checkpointDatabase(capabilities, message)`** – stages all files and creates a git commit
  (no-op if nothing has changed).  Called at migration boundaries.
- **`synchronizeNoLock(capabilities, options)`** – checkpoints and then synchronises with the
  remote generators repository (`git pull` + `git push`).

See [`docs/gitstore.md`](./gitstore.md) for the gitstore primitives that back these operations.
