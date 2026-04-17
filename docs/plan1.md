# Plan: O(n) Gentle Unification Algorithm

## Problem

The previous gentle-unification implementation had two memory-inefficiency issues in the filesystem adapters:

1. **`fs_to_db.js`** cached the entire target sublevel (`targetCache: Map<rawKey, value>`) during
   `listTargetKeys()`. For large `values` sublevels this held all database values in memory at once.

2. **`db_to_fs.js`** cached every serialized source value (`sourceCache: Map<relPath, string>`)
   during `listSourceKeys()`. For large sublevels this held every rendered JSON string simultaneously.

The original core algorithm also materialised two `Set<string>` objects (source keys + target keys)
before any I/O, requiring O(|source_keys| + |target_keys|) key memory.

## Goal

O(n log n) overall time (dominated by key-list sorts in the adapters), with  
O(n) memory where  
`n = max(max_value_size, total_key_count + total_edge_count)`

The **core merge-join** itself is O(n) time and O(V) memory (V = largest value size),
given sorted key streams.  Adapters that cannot stream pre-sorted keys must sort a
list of key strings first, paying an extra O(n log n) sort cost.  Values are never
retained in the key lists; only short path strings are held while sorting.

At any instant the core engine retains:
- At most one source value **and** at most one target value.
- Key lists hold only short strings (file paths / node-key JSON), not values.

## Algorithm: sorted merge-join

Replace the three-phase set algorithm (materialise keys → deletes → puts) with a **two-pointer
merge-join** over sorted key streams.

### Requirements

Both `listSourceKeys()` and `listTargetKeys()` MUST yield keys in ascending lexicographic order.

Keys MUST be latin1 strings that do not contain the substring `!!`.  For latin1 strings,
JavaScript's default string comparison (by code point) is identical to byte-order comparison,
which matches LevelDB's native iteration order.  Adapters that sort keys in JS can therefore
use the plain `Array.prototype.sort()` with no custom comparator.

> **TODO**: Some ConstValue arguments may contain characters outside the latin1 range.  In that
> case JS string comparison may diverge from LevelDB byte order.  This edge case is tracked
> separately and will be addressed in a future change.

### Pseudocode

```
sNext = await sourceIter.next()
tNext = await targetIter.next()

while !sNext.done || !tNext.done:
  if      sNext.done:  cmp = +1   // only in target → delete
  else if tNext.done:  cmp = -1   // only in source → put
  else:                cmp = sNext.value < tNext.value ? -1 : sNext.value > tNext.value ? 1 : 0

  if cmp < 0:
    sv = readSource(sNext.value)
    putTarget(sNext.value, sv)
    sNext = await sourceIter.next()
  elif cmp > 0:
    deleteTarget(tNext.value)
    tNext = await targetIter.next()
  else:  // cmp === 0
    sv = readSource(sNext.value)
    tv = readTarget(tNext.value)
    if JSON.stringify(sv) !== JSON.stringify(tv): putTarget(sNext.value, sv)
    sNext = await sourceIter.next()
    tNext = await targetIter.next()
```

**Why deletes before conflicting puts?**
With sorted keys, a stale target key `values/foo` always compares less than a new source key
`values/foo/bar` (because the shorter prefix string is lexicographically smaller). The merge-join
therefore processes the delete step for `values/foo` before the put step for `values/foo/bar`,
avoiding write failures caused by structural path conflicts.

## Non-atomicity by design

`unifyStores()` is intentionally **not atomic**. A failure mid-run may leave the target in a
partially-updated state. Atomicity is guaranteed at a higher level by the **replica-cutover
mechanism**: the target store is always an *inactive* replica that is never read until cutover
succeeds. Callers must not expect rollback behaviour from unification.

This design removes the need for `begin`/`commit`/`rollback` lifecycle methods from the adapter
interface, greatly simplifying both the core engine and every adapter.

## Equality comparison

Values are opaque JSON objects. Equality is computed as
`JSON.stringify(a) === JSON.stringify(b)` — no sorting, no canonicalization, and no
normalization of object key order before comparison. Two values are equal only if their JSON
representations are byte-identical. This means that object key insertion order is part of
equality; the same logical value stored with a different key order is treated as different.
No canonicalization is performed: values are compared as they come out of LevelDB or the
filesystem.

## Adapter changes

### `core.js`
Rewritten to the merge-join above. No `Set` objects. No begin/commit/rollback. Memory: O(max_value_size) at any time.

### `db_to_db.js`
- `DATA_SUBLEVELS` reordered to `['counters','freshness','inputs','revdeps','timestamps','values']`
  (alphabetical). This makes composite keys `{sublevel}\x00{nodeKey}` globally sorted so both
  source and target iterators produce keys in the same lexicographic order.
- `InMemorySchemaStorage.makeSubstorage.keys()` now sorts Map keys before yielding, to match
  LevelDB's byte-sorted order for ASCII NodeKey strings.
- Writes are applied immediately (no buffering): each `putTarget` calls `rawPut()` and each
  `deleteTarget` calls `rawDel()` directly on the target sublevel. No `batch()` calls.
  `rawPut`/`rawDel` use `sync:false` for performance. O(max_value_size) peak memory — at most
  one value is live in the call frame at any instant.
- Callers must invoke `rootDatabase._rawSync()` once after `unifyStores()` to flush the WAL
  with a single fsync.

### `migration_runner.js` – `makeLazyMigrationSource`
Each sublevel's `keys()` method sorts decision-map keys before yielding, so the lazy source
produces sorted output compatible with the merge-join when paired with a real (LevelDB) target.

### `fs_to_db.js`
- `listSourceKeys()`: collects all file paths → maps each to a raw DB key → sorts → yields sorted.
  No value caching.
- `listTargetKeys()`: streams raw keys from `_rawEntriesForSublevel` (already sorted). No value
  caching.
- `readTarget(rawKey)`: on-demand DB read via `rootDatabase._rawGetInSublevel(sublevel, innerKey)`.
  O(log n) per call, O(1) memory.
- `putTarget(rawKey, value)`: writes the value immediately via `rootDatabase._rawPut(rawKey, value)`
  with `sync:false`. One value in memory at a time. No buffering.
- `deleteTarget(rawKey)`: deletes immediately via `rootDatabase._rawDel(rawKey)` with `sync:false`.
  No buffering.
- `flush()`: calls `rootDatabase._rawSync()` to perform the single fsync after the merge-join.

### `db_to_fs.js`
- `listSourceKeys()`: collects all relPaths from LevelDB → sorts → yields sorted. No value caching.
  Memory: O(num_keys × avg_relpath_length).
- `listTargetKeys()`: collects all file relPaths → sorts → yields sorted. No value caching.
- `readSource(relPath)`: maps relPath → innerKey via `relativePathToKey`, then calls
  `rootDatabase._rawGetInSublevel(sublevel, innerKey)` + `serializeValue()`. O(log n) per call,
  O(max_value_size) peak memory.

### `root_database.js`
- New helper `_rawGetInSublevel(sublevelName, innerKey)`: constructs a fresh sublevel wrapper via
  `this.db.sublevel(sublevelName, { valueEncoding: 'json' })` on each call (no caching), then
  calls `sublevel.get(innerKey)`. No `_sublevelCache` exists; per-key reads always build a new
  wrapper to avoid unbounded memory growth in long-running processes.
- `_rawPut(key, value)`: writes a single raw key to the root LevelDB instance with `sync:false`.
  Used by `fs_to_db.js` putTarget.
- `_rawDel(key)`: deletes a single raw key with `sync:false`. Used by `fs_to_db.js` deleteTarget.
- `_rawSync()`: submits an empty batch with `sync:true` to force one LevelDB
  WAL fsync. No data is written. Must be called once after all unification writes complete.

### `database/encoding.js`  (new — promoted from `render/encoding.js`)
Encoding functions (`keyToRelativePath`, `relativePathToKey`, `serializeValue`, `parseValue`) are
now a standalone module at the `database/` level with no imports from the unification or render
subsystems.  This completely eliminates the circular-dependency cycle:

**Old cycle:**
```
render/index.js → render.js → ../unification → db_to_fs.js → ../render → render/index.js
```

**New (no cycle):**
```
unification/db_to_fs.js  → ../encoding   (standalone leaf)
unification/fs_to_db.js  → ../encoding   (standalone leaf)
render/index.js          → ../encoding   (standalone leaf)
                         → ./render       (render.js → ../unification  -- fine, no cycle back)
```

`render/encoding.js` is kept as a thin re-export shim (`module.exports = require('../encoding')`)
for any code that imports encoding from the render subfolder.

## Memory summary

| Component | Peak memory (old) | Peak memory (new) |
|---|---|---|
| `core.js` key sets | O(source_keys + target_keys) | O(1) |
| `fs_to_db` target cache | O(target_values_total) | O(1) (on-demand read) |
| `db_to_fs` source cache | O(source_values_total) | O(1) (on-demand read) |
| Adapter write buffer | O(RAW_BATCH_CHUNK_SIZE × max_value) | O(max_value) (immediate writes) |
| Key lists for sorting | O(1) per adapter | O(num_keys × avg_key_len) |
| **Overall** | **O(total_values)** | **O(max_value + num_keys)** |
