# Temporary Storage

The `temporary` module provides a LevelDB-backed key–value store for short-lived
data that arises during request processing — most notably uploaded file contents
and request-completion markers.

---

## Why LevelDB instead of the filesystem?

The old approach kept per-request artefacts in a `requests/<id>/` directory tree
inside the application's working directory.  This had several drawbacks:

* **Non-atomic writes** – a partially-written directory was visible to readers.
* **Directory pollution** – failed requests left stale directories behind with no
  automatic cleanup.
* **No structured storage** – binary blobs and metadata sat side-by-side as plain
  files with no type information.

LevelDB batch writes are atomic: either the entire set of changes is visible or
none of it is.  The database also lives in a single directory
(`<workingDirectory>/temporary-leveldb/`) that is easy to identify and purge.

---

## Conceptual overview

### Key namespaces

All keys are plain strings.  Two logical namespaces are used:

| Prefix            | Purpose                                     |
|-------------------|---------------------------------------------|
| `blob/<id>/<name>`| Binary content for an uploaded file         |
| `done/<id>`       | Completion marker for a finished request    |

### Value encoding

Values are JSON objects with a discriminant `type` field:

```json
{ "type": "blob", "data": "<base64-encoded bytes>" }
{ "type": "done" }
```

Using JSON throughout keeps the database consistent with the rest of the
codebase and avoids a separate binary encoding scheme.

---

## Module layout

```
backend/src/temporary/
  database/
    types.js   – branded types and conversion helpers (TempKey, TempEntry)
    index.js   – TemporaryDatabase class and factory (makeTemporaryDatabase,
                 getTemporaryDatabase)
  index.js     – high-level Temporary class (storeBlob, getBlob, deleteBlob,
                 markDone, isDone) and its make() factory
```

The split mirrors `generators/incremental_graph/database/` (low-level LevelDB
plumbing) vs `generators/incremental_graph/` (high-level graph operations).

---

## Atomicity guarantee

Every write that should be visible together is issued via a single
`database.batch(ops)` call, which LevelDB guarantees to be atomic.  For the
current workloads (single blob per store call, single done marker) each
operation is a single `put`, which is also atomic.

---

## Lifecycle

The database is opened lazily on first use via the `Temporary` class held in
`capabilities.temporary`.  The same `Temporary` instance is reused for the
lifetime of the process.

---

## Using the conceptual interface

```js
const { makeTemporary } = require('./temporary');

// capabilities.temporary is created once in capabilities/root.js:
//   temporary: makeTemporary(() => capabilities)

// Store an uploaded file buffer:
await capabilities.temporary.storeBlob(reqId, 'audio.weba', buffer);

// Retrieve it later:
const buf = await capabilities.temporary.getBlob(reqId, 'audio.weba');

// Delete after use:
await capabilities.temporary.deleteBlob(reqId, 'audio.weba');

// Mark a request as finished and check later:
await capabilities.temporary.markDone(reqId);
const finished = await capabilities.temporary.isDone(reqId);
```

---

## Filesystem path

The database lives at:

```
<workingDirectory>/temporary-leveldb/
```

It is intentionally separate from `generators-leveldb/` so that the two stores
can be cleared independently.
