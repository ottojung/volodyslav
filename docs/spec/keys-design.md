# IncrementalGraph internal node identifiers

## Purpose

This document describes the target state for IncrementalGraph node addressing after
internal `NodeIdentifier`s are introduced.

The target state separates three concerns:

- `NodeKey` is the semantic identity of a concrete node instance
- `NodeIdentifier` is the persisted storage identity of a materialized node
- filesystem snapshots and the HTTP inspection API operate directly on stored identifiers

## Terms

- **NodeKey**: the schema-derived identity of a concrete node instance, based on
  `(head, args)`
- **NodeIdentifier**: the opaque random identifier attached to a materialized node
- **graph-state sublevels**: `values`, `freshness`, `inputs`, `revdeps`, `counters`,
  `timestamps`

## Target-state boundary

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

### HTTP inspection API

The HTTP inspection API is not a user-facing API. It is an internal development and
inspection surface.

In the target state, every HTTP operation that addresses or returns a concrete node
instance uses `NodeIdentifier`, not `NodeKey`.

The older concrete-node HTTP shape based on `head/arg0/arg1/...` is not part of the
target state.

## NodeIdentifier requirements

A `NodeIdentifier` is an opaque random identifier with the following properties:

- latin-1 / ASCII only
- stable for the lifetime of that materialized node in storage
- round-trippable as a nominal typed value
- unique within the database
- suitable for direct use as persisted key content and as a filesystem path segment

Stored key content for node identifiers MUST NOT contain the substring `"!!"`.
That substring is reserved for sublevel delimiters in raw LevelDB keys and must appear
only there.

This requirement is part of the `NodeIdentifier` value definition itself. So any
implementation that constructs, parses, or accepts a `NodeIdentifier` must enforce it,
not just the documentation.

Example values:

- `gid0123456789abcdef`
- `gidfedcba9876543210`

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

`revdeps` stores `NodeIdentifier[]`, but deterministic ordering is still defined by the
corresponding `NodeKey` order.

So the target state is:

- persisted reverse-dependency references are identifiers only
- deterministic ordering is still derived from `node_id_to_key`

## Filesystem snapshot format

`render()` and `scan()` operate on the new identifier-based keys, not on the older
`NodeKey`-derived path form.

The older concrete-node filesystem shape:

- `rendered/r/values/head/arg1/arg2/arg3`

is not part of the target state.

The target concrete-node filesystem shape is:

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

## No key↔path conversion in the target state

There must not be any code whose job is to convert concrete node keys to filesystem
paths or to reconstruct concrete node keys from filesystem paths.

This prohibition covers both:

- dedicated helper functions for `NodeKey ↔ path` conversion
- incidental logic embedded inside render/scan/unification code that reconstructs a
  concrete `NodeKey` from path segments or encodes one into path segments

In the target state:

- graph-state filesystem paths are direct identifier paths
- scan consumes those direct identifier paths
- render writes those direct identifier paths

So the older model of encoding `NodeKey(head, args)` into path segments is absent from
the target state.

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
