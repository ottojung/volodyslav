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

O(n) memory **and** time, where  
`n = max(max_value_size, total_key_count + total_edge_count)`

At any instant:
- At most one source value **and** at most one target value live in memory.
- Key lists hold only short strings (file paths / node-key JSON), not values.

## Algorithm: sorted merge-join

Replace the three-phase set algorithm (materialise keys → deletes → puts) with a **two-pointer
merge-join** over sorted key streams.

### Requirements

Both `listSourceKeys()` and `listTargetKeys()` MUST yield keys in ascending lexicographic order.

### Pseudocode

```
sNext = await sourceIter.next()
tNext = await targetIter.next()

while !sNext.done || !tNext.done:
  if      sNext.done:  cmp = +1   // only in target → delete
  else if tNext.done:  cmp = -1   // only in source → put
  else:                cmp = sNext.value.localeCompare(tNext.value)

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

Values are opaque JSON objects. No assumptions are made about key ordering within objects.
Equality is computed as `JSON.stringify(a) === JSON.stringify(b)` — no sorting, no
canonicalization. Two values are equal only if their JSON representations are byte-identical.

## Adapter changes

### `core.js`
Rewritten to the merge-join above. No `Set` objects. No begin/commit/rollback. Memory: O(max_value_size) at any time.

### `db_to_db.js`
- `DATA_SUBLEVELS` reordered to `['counters','freshness','inputs','revdeps','timestamps','values']`
  (alphabetical). This makes composite keys `{sublevel}\x00{nodeKey}` globally sorted so both
  source and target iterators produce keys in the same lexicographic order.
- `InMemorySchemaStorage.makeSubstorage.keys()` now sorts Map keys before yielding, to match
  LevelDB's byte-sorted order for ASCII NodeKey strings.
- Writes are applied immediately (no buffer): each `putTarget`/`deleteTarget` calls
  `target.batch([singleOp])` immediately. O(max_value_size) peak memory.

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
- `putTarget(rawKey, value)`: writes the value immediately to the DB via `_rawPutAll([{key, value}])`.
  One value in memory at a time. No buffering.
- `deleteTarget(rawKey)`: deletes immediately via `_rawDeleteKeys([rawKey])`. No buffering.

### `db_to_fs.js`
- `listSourceKeys()`: collects all relPaths from LevelDB → sorts → yields sorted. No value caching.
  Memory: O(num_keys × avg_relpath_length).
- `listTargetKeys()`: collects all file relPaths → sorts → yields sorted. No value caching.
- `readSource(relPath)`: maps relPath → innerKey via `relativePathToKey`, then calls
  `rootDatabase._rawGetInSublevel(sublevel, innerKey)` + `serializeValue()`. O(log n) per call,
  O(max_value_size) peak memory.

### `root_database.js`
New helper `_rawGetInSublevel(sublevelName, innerKey)`: opens the sublevel with JSON encoding and
calls `sublevel.get(innerKey)`. Used by `fs_to_db.js` and `db_to_fs.js` for on-demand reads.

### `render/index.js`
Exports encoding functions (`keyToRelativePath`, `relativePathToKey`, `serializeValue`,
`parseValue`) **before** requiring `scan.js`. This breaks the circular-dependency cycle:

```
fs_to_db.js → render/index.js → scan.js → unification/ → fs_to_db.js
```

Node.js resolves circular requires by returning the **partial** exports object that has been
populated so far. By exporting encoding functions first (before `require('./scan')`), the partial
object already contains the functions that `fs_to_db.js`/`db_to_fs.js` need, so they receive the
correct values even mid-cycle.

## Memory summary

| Component | Peak memory (old) | Peak memory (new) |
|---|---|---|
| `core.js` key sets | O(source_keys + target_keys) | O(1) |
| `fs_to_db` target cache | O(target_values_total) | O(1) (on-demand read) |
| `db_to_fs` source cache | O(source_values_total) | O(1) (on-demand read) |
| Adapter write buffer | O(RAW_BATCH_CHUNK_SIZE × max_value) | O(max_value) (immediate writes) |
| Key lists for sorting | O(1) per adapter | O(num_keys × avg_key_len) |
| **Overall** | **O(total_values)** | **O(max_value + num_keys)** |
