# IncrementalGraph internal node identifiers

## Purpose

This document is the **intended target design specification** for IncrementalGraph
node addressing. It describes the model as it is meant to be. It does not describe
the current state.

This document defines the node-addressing model for IncrementalGraph storage,
filesystem snapshots, and the HTTP inspection API.

This model separates three concerns:

- `NodeKey` is the semantic identity of a concrete node instance
- `NodeIdentifier` is the persisted storage identity of a materialized node
- filesystem snapshots and the HTTP inspection API operate directly on stored identifiers

## Terms

- **NodeKey**: the schema-derived identity of a concrete node instance, based on
  `(head, args)`
- **NodeIdentifier**: the opaque random identifier attached to a materialized node
- **graph-state sublevels**: `values`, `freshness`, `inputs`, `revdeps`, `counters`,
  `timestamps`

## Boundary

### IncrementalGraph and Interface API

The `IncrementalGraph` API and the higher-level `Interface` API continue to address
nodes by `NodeKey`.

That includes:

- `pull(head, args)`
- `invalidate(head, args)`
- `getValue(head, args)`
- `getFreshness(head, args)`
- `getCreationTime(head, args)`
- `getModificationTime(head, args)`
- `listMaterializedNodes()`

For these APIs, callers do not pass `NodeIdentifier`s.

`NodeKey` is used exclusively at this user-facing boundary. It is not used for any
internal logic. Inside the storage layer, all node addressing, sorting, and
edge-following uses `NodeIdentifier` only. `NodeKey` values appear only as arguments
or return values of user-facing API calls and in the bijection lookup tables.

### HTTP inspection API

The HTTP inspection API is not a user-facing API. It is an internal development and
inspection surface.

Every HTTP operation that addresses or returns a concrete node instance uses
`NodeIdentifier`.

## NodeIdentifier requirements

A `NodeIdentifier` is an opaque random identifier with the following properties:

- stable for the lifetime of that materialized node in storage
- round-trippable as a nominal type
- unique within the database
- suitable for direct use as persisted key content and as a filesystem path segment
- matches `/^[a-z_][a-z0-9_]*$/` (full-string match)

So the allowed character set is:

- lowercase ASCII letters `a-z`
- ASCII digits `0-9`
- underscore `_`

The first character is a lowercase ASCII letter or underscore.

No other characters are permitted in a `NodeIdentifier`. In particular, a
`NodeIdentifier` MUST NOT contain `/`, `\`, `.`, whitespace, control characters, `!`,
or any other punctuation.

A `NodeIdentifier` MUST NOT contain the substring `"!!"`. That substring is reserved
for sublevel delimiters in raw LevelDB keys and must appear only there.

These requirements are part of the `NodeIdentifier` value definition itself. So any
implementation that constructs, parses, or accepts a `NodeIdentifier` must enforce
them, not just the documentation.

Example values:

- `nodeid1`
- `gid_0123456789abcdef`
- `_cache3`

## Persisted storage model

All persisted graph state addresses nodes by `NodeIdentifier`, not by `NodeKeyString`.

This applies to:

- keys in all graph-state sublevels
- values inside `inputs`
- values inside `revdeps`
- migration-produced state
- filesystem-rendered snapshots
- HTTP API addressing of concrete nodes

### Graph-state sublevels

- `values[id] -> ComputedValue`
- `freshness[id] -> Freshness`
- `counters[id] -> Counter`
- `timestamps[id] -> TimestampRecord`
- `inputs[id] -> { inputs: NodeIdentifier[], inputCounters: number[] }`
- `revdeps[id] -> NodeIdentifier[]`

### Lookup metadata

The database contains an explicit bijection between the semantic identity and the
persisted identity:

- `node_key_to_id[nodeKey] -> id`
- `node_id_to_key[id] -> nodeKey`

`NodeKeyString` may remain persisted only in these lookup sublevels.

## Allocation and stability

Every materialized node has exactly one `NodeIdentifier`.

When a concrete `NodeKey` becomes materialized:

- if it already has an identifier, that identifier is reused
- otherwise a fresh identifier is allocated and recorded in both lookup sublevels

Recompute, invalidate, cache-hit, and migration-preserve flows keep the existing
identifier.

Delete removes:

- all graph-state records keyed by `id`
- `node_key_to_id[nodeKey]`
- `node_id_to_key[id]`

Migration preserves identifiers for `keep`, `override`, and `invalidate`, and allocates
fresh identifiers for `create`.

## Determinism

`revdeps` stores `NodeIdentifier[]` in ascending lexicographic order of the identifier
string itself.

`NodeKey` is not consulted when ordering reverse-dependency lists. All internal
sorting operates on `NodeIdentifier` values directly.

## Bijection cache

The full contents of both lookup sublevels (`node_key_to_id` and `node_id_to_key`)
are loaded into RAM and kept synchronized as an in-memory cache. All lookups between
`NodeKey` and `NodeIdentifier` go through this cache, not through direct database
reads at call time.

The cache is authoritative for the bijection while the database is open. Writes to
the lookup sublevels and updates to the cache are atomic from the perspective of the
storage layer.

## Filesystem snapshot format

`render()` and `scan()` operate on identifier-addressed graph-state paths.

Each graph-state record appears at a direct identifier path, for example:

- `rendered/r/values/nodeid1`

and analogously for the other graph-state sublevels:

- `rendered/r/freshness/nodeid1`
- `rendered/r/inputs/nodeid1`
- `rendered/r/revdeps/nodeid1`
- `rendered/r/counters/nodeid1`
- `rendered/r/timestamps/nodeid1`

Lookup metadata remains explicit and separate:

- `rendered/r/node_key_to_id/{node-key-encoding}`
- `rendered/r/node_id_to_key/nodeid1`

The snapshot format therefore exposes graph-state records directly by identifier and
uses lookup tables for semantic readability.

## No key↔path conversion

Outside the explicit lookup-metadata namespace, there must not be any code whose job
is to convert concrete node keys to filesystem paths or to reconstruct concrete node
keys from filesystem paths.

This prohibition applies to graph-state addressing and covers both:

- dedicated helper functions for `NodeKey ↔ path` conversion used for graph-state
  files
- incidental logic embedded inside render/scan/unification code that reconstructs a
  concrete `NodeKey` from graph-state path segments or encodes one into graph-state
  path segments

The following lookup-metadata paths are explicitly exempt from this prohibition:

- `rendered/r/node_key_to_id/{node-key-encoding}`
- `rendered/r/node_id_to_key/nodeid1`

Those paths may encode or decode `NodeKey` values for the sole purpose of reading and
writing the lookup tables. They must not be treated as a general filesystem addressing
scheme for graph-state records.

Accordingly:

- graph-state filesystem paths are direct identifier paths
- scan consumes those direct identifier paths
- render writes those direct identifier paths
- any `NodeKey ↔ path` logic is limited to the lookup-metadata namespace above

## Invariants

For every materialized node identifier `id`:

1. `node_id_to_key[id] = key`
2. `node_key_to_id[key] = id`
3. all graph-state records for that node are keyed by `id`
4. every entry inside `inputs[id].inputs` is a valid `NodeIdentifier`
5. every entry inside `revdeps[id]` is a valid `NodeIdentifier`

No persisted graph edge may point directly to a `NodeKeyString`.

## Corruption conditions

The following states are invalid:

- `node_key_to_id[key]` exists but `node_id_to_key[id]` is missing
- `node_id_to_key[id]` exists but `node_key_to_id[key]` is missing
- lookup entries disagree about each other
- a graph-state record exists for an id with no `node_id_to_key` entry
- `inputs` or `revdeps` mention an unknown id
