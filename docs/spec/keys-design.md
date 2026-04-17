# IncrementalGraph internal node identifiers

## Problem

Today the incremental-graph database uses `NodeKeyString` as both:

- the public address of a node instance, and
- the persisted storage key/reference for that node.

That is visible in all current graph-state sublevels:

- `values`
- `freshness`
- `inputs`
- `revdeps`
- `counters`
- `timestamps`

These six sublevels are referred to below as the **graph-state sublevels**.

It is also visible in migration code and in the filesystem snapshot encoding, which currently renders keys such as:

- `x/values/event/abc123`
- `x/freshness/event/abc123`
- `x/inputs/event/abc123`
- `x/revdeps/event/abc123`

This was acceptable while `NodeKey` was the only identity we needed. It is no longer sufficient because:

1. `NodeKey` is schema-derived rather than universally unique.
2. We now care about latin-1-safe storage keys.
3. We want a stable internal address that can be used uniformly across persisted graph metadata.

## Goal

Introduce a new **internal-only** identifier for each materialized node:

- random
- latin-1 safe
- stable for the lifetime of that node in storage
- never exposed as part of the `IncrementalGraph` or `Interface` API

Public APIs must continue to address nodes by `(head, args)` / `NodeKey`.

## Non-goals

- Changing the public `IncrementalGraph` API
- Changing the public `Interface` API
- Making callers pass node identifiers
- Replacing `NodeKey` as the schema-level notion of node identity

`NodeKey` remains the public and semantic identity. `NodeIdentifier` becomes the persisted storage identity.

## New type

Add a nominal type parallel to `EventId`:

- module shape similar to `backend/src/event/id.js`
- generated with the existing helper at `backend/src/random/string.js`, using the same capability-driven seed pattern as `backend/src/event/id.js` (`capabilities.seed`, not a raw system API)
- stored as lowercase alphanumeric text, optionally with a `gid` prefix in examples

Example values:

- `gid0123456789abcdef`
- `gidfedcba9876543210`

Requirements:

- latin-1 / ASCII only
- collision checked against existing stored identifiers before commit
- round-trippable with `make`, `fromString`, `toString`

## Storage model

### Rule

All persisted graph state must address nodes by `NodeIdentifier`, not by `NodeKeyString`.

This applies to:

- keys in all graph-state sublevels
- values inside `inputs`
- values inside `revdeps`
- migration-produced state
- filesystem-rendered database snapshots

### Required lookup metadata

To preserve the current public API, the database also needs a bijection between public keys and internal identifiers.

Add two new metadata sublevels:

1. `node_key_to_id`
   - key: `NodeKeyString`
   - value: `NodeIdentifier`
2. `node_id_to_key`
   - key: `NodeIdentifier`
   - value: `NodeKeyString`

This is the **only** place where `NodeKeyString` may remain persisted as node-address metadata.
All actual graph state and all graph-to-graph references must use `NodeIdentifier`.

## New per-sublevel representation

### Primary data

- `values[id] -> ComputedValue`
- `freshness[id] -> Freshness`
- `counters[id] -> Counter`
- `timestamps[id] -> TimestampRecord`

### Dependency metadata

- `inputs[id] -> { inputs: NodeIdentifier[], inputCounters: number[] }` — stores dependency identifiers and their corresponding counter values
- `revdeps[id] -> NodeIdentifier[]` — stores reverse-dependency identifiers

### Lookup metadata

- `node_key_to_id[nodeKey] -> id`
- `node_id_to_key[id] -> nodeKey`

## Public/API boundary

The boundary remains unchanged:

- `pull(head, args)`
- `invalidate(head, args)`
- `getValue(head, args)`
- `getFreshness(head, args)`
- `getCreationTime(head, args)`
- `getModificationTime(head, args)`
- `listMaterializedNodes()`

All of these continue to accept or return `NodeKey`-shaped data.

Internally the flow becomes:

1. public API constructs `NodeKeyString`
2. graph resolves `NodeKeyString -> NodeIdentifier`
3. storage reads/writes by `NodeIdentifier`
4. when public output is needed, graph resolves `NodeIdentifier -> NodeKeyString`

## Allocation rules

### First materialization

When a node is first materialized:

1. compute its `NodeKeyString` as today
2. look up `node_key_to_id[nodeKey]`
3. if present, reuse it
4. if absent:
   - generate a fresh random `NodeIdentifier`
   - verify `node_id_to_key[id]` does not already exist
   - atomically write both lookup records

Only after the lookup pair exists may graph-state records be written.

### Recompute / invalidate / cache hit

These operations must reuse the existing identifier. They must never allocate a second identifier for the same `NodeKeyString`.

### Delete

A true delete removes:

- all graph-state records keyed by `id`
- `node_key_to_id[nodeKey]`
- `node_id_to_key[id]`

### Migration

Migration decisions stay `NodeKey`-based at the callback/API layer.

When applying decisions:

- `keep`, `override`, `invalidate`: preserve the existing identifier
- `create`: allocate a new identifier
- `delete`: remove the identifier and both lookup entries

This keeps identifiers stable across compatible schema migrations.

## Determinism and ordering

Today some internal arrays are kept in `NodeKey` order for determinism.
That behavior should be preserved even after switching stored references to identifiers.

Therefore:

- `revdeps` stores `NodeIdentifier[]`
- but insertion/sorting should still use the corresponding `NodeKey` order via `node_id_to_key`

This keeps traversal behavior deterministic without leaking `NodeKey` into persisted references.

## Filesystem rendering / snapshot format

The current renderer special-cases graph data sublevels as `NodeKey`-encoded paths.
That must change.

### New snapshot form

Opaque graph-state files become identifier-addressed:

- `x/values/gid7k2w6f0m4r8q1p9s`
- `x/freshness/gid7k2w6f0m4r8q1p9s`
- `x/inputs/gid7k2w6f0m4r8q1p9s`
- `x/revdeps/gid7k2w6f0m4r8q1p9s`

Lookup metadata carries the readable mapping:

- `x/node_key_to_id/event/abc123`
- `x/node_id_to_key/gid7k2w6f0m4r8q1p9s`

So snapshots become less directly human-readable in the primary data sublevels, but they retain inspectability via the explicit lookup tables.

### Encoding rule

`database/encoding.js` must distinguish three cases:

1. meta sublevels with plain string keys (`_meta`, `meta`)
2. lookup sublevels, split into `NodeKey`-keyed (`node_key_to_id`) and `NodeIdentifier`-keyed (`node_id_to_key`) variants
3. graph-state sublevels keyed by `NodeIdentifier` (the six graph-state sublevels defined above)

## Invariants

For every materialized node identifier `id`:

1. `node_id_to_key[id] = key`
2. `node_key_to_id[key] = id`
3. `values`, `freshness`, `inputs`, `counters`, `timestamps` for that node are keyed by `id`
4. every entry inside `inputs[id].inputs` is a valid `NodeIdentifier`
5. every entry inside `revdeps[id]` is a valid `NodeIdentifier`

No persisted graph edge may point directly to a `NodeKeyString`.

## Corruption handling

The implementation should treat these as database corruption:

- `node_key_to_id[key]` exists but `node_id_to_key[id]` is missing
- `node_id_to_key[id]` exists but `node_key_to_id[key]` is missing
- lookup entries disagree about each other
- a graph-state record exists for an id with no `node_id_to_key` entry
- `inputs` / `revdeps` mention an unknown id

## Minimal implementation strategy

The smallest compatible refactor is:

1. keep schema compilation and concrete-node creation keyed by `NodeKeyString`
2. introduce identifier resolution only at the storage boundary
3. change persisted sublevels and dependency payloads to identifiers
4. translate back to `NodeKeyString` only when returning data to public callers

This keeps the existing graph API intact while making identifiers a purely internal storage concern.
