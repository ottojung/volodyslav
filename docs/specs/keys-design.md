# IncrementalGraph internal node identifiers

## Purpose

This document defines the node-addressing model for IncrementalGraph storage,
filesystem snapshots, and the HTTP inspection API.

This model separates three concerns:

- `NodeKey` is the semantic identity of a concrete node instance
- `NodeIdentifier` is the persisted storage identity of a materialized node
- filesystem snapshots and internal storage operate directly on stored identifiers

This document is the **intended target design specification** for IncrementalGraph
node addressing. It describes the model as it is meant to be.

## Terms

- **NodeKey**: the schema-derived identity of a concrete node instance, based on
  `(head, args)`
- **NodeIdentifier**: the opaque random identifier attached to a materialized node
- **graph-state sublevels**: `values`, `freshness`, `inputs`, `revdeps`, `counters`,
  `timestamps`

## Boundary

Public concrete-node operations remain `NodeKey`-addressed (`head + args` / `NodeKey`).

`IncrementalGraph` is the conversion boundary:

- Public callers and HTTP routes provide semantic keys (`head + args` / `NodeKey`).
- At public method entry, `IncrementalGraph` resolves to `NodeIdentifier` immediately.
- All logic below that boundary (storage, recompute, invalidation propagation, migration, sync, render, scan) is identifier-native.

`nodeKeyToId(nodeKey)` and `nodeIdToKey(id)` are internal/lower-level translation helpers,
not public `IncrementalGraph` methods and not HTTP API operations.

### Required workflow

Upstream/public workflow stays semantic:

```js
await graph.pull(head, args);
await graph.invalidate(head, args);
```

Internal workflow converts once at the boundary, then stays identifier-native.

No mixed model is allowed where storage-layer concrete-node operations remain `NodeKey`-addressed after boundary conversion.

### Schema/head APIs

Schema-family APIs may remain head/schema-oriented where they are genuinely schema-level
operations rather than concrete-node operations.

### Migration API boundary

Migration code is internal storage logic, so migrations are fully `NodeIdentifier`-addressed.

- Migration callbacks must receive and return concrete-node references as `NodeIdentifier` values.
- Migration-produced `inputs`/`revdeps` must contain only `NodeIdentifier` values.
- Migration control decisions (`keep`, `override`, `invalidate`, `create`, `delete`) operate on `NodeIdentifier`-addressed state, with `NodeKey` used only via the lookup bijection when needed for schema/head filtering or inspection.

There is no mixed-mode migration API: `NodeKey`-addressed migration payloads are out of scope and unsupported.

### HTTP inspection API

HTTP concrete-node routes remain `head + args` based to preserve existing API behavior.

- Route addressing remains semantic (`head + args`).
- Handlers call the public graph API in semantic form.
- Identifier conversion happens inside `IncrementalGraph` at the same boundary as non-HTTP callers.
- `NodeIdentifier` is not exposed as required request-addressing for public graph routes.

## NodeIdentifier requirements

A `NodeIdentifier` is an opaque random identifier with the following properties:

- stable for the lifetime of that materialized node in storage
- round-trippable as a nominal type
- unique within the database
- suitable for direct use as persisted key content and as a filesystem path segment
- matches `/^[a-z]*$/` (full-string match)

So the allowed character set is:

- lowercase ASCII letters `a-z`

No other characters are permitted in a `NodeIdentifier`. In particular, a
`NodeIdentifier` MUST NOT contain `/`, `\`, `.`, whitespace, control characters, `!`,
or any other punctuation.

These requirements are part of the `NodeIdentifier` value definition itself. So any
implementation that constructs, parses, or accepts a `NodeIdentifier` must enforce
them, not just the documentation.

Example values:

- `aaaaaaaaa`
- `nodecachex`
- `zzzzzzzzz`

## Persisted storage model

All persisted graph state addresses nodes by `NodeIdentifier`, not by `NodeKeyString`.

This applies to:

- keys in all graph-state sublevels
- values inside `inputs`
- values inside `revdeps`
- all migration callback payloads and migration-produced state
- filesystem-rendered snapshots

### Graph-state sublevels

- `values[id] -> ComputedValue`
- `freshness[id] -> Freshness`
- `counters[id] -> Counter`
- `timestamps[id] -> TimestampRecord`
- `inputs[id] -> { inputs: NodeIdentifier[], inputCounters: number[] }`
- `revdeps[id] -> NodeIdentifier[]`

### Storage invariants

- graph-state sublevel keys are `NodeIdentifier`
- `inputs[id].inputs` contains `NodeIdentifier[]`
- `revdeps[id]` contains `NodeIdentifier[]`
- reverse dependencies are sorted by `NodeIdentifier` (lexicographic), never by `NodeKey`
- render/scan paths use direct identifier path segments
- graph-state path encoding/decoding must not reconstruct `NodeKey` values
- `NodeKeyString` may persist only inside explicit lookup metadata (`identifiers_keys_map`)

### Lookup metadata

The database contains an explicit bijection between the semantic identity and the
persisted identity:

- `nodeKeyToId(nodeKey) -> id`
- `nodeIdToKey(id) -> nodeKey`

These functions operate on the `/${current_replica}/global/identifiers_keys_map` database value.
Here `${current_replica}` is the replica name of the current database instance, for example `x` or `y`.

`NodeKeyString` may remain persisted only in this lookup table at `/${current_replica}/global/identifiers_keys_map`.

The map is the materialized-node identity table, with a strict invariant:

1. contains every materialized node;
2. contains only materialized nodes.

Lifecycle rules:

- `NodeIdentifier` allocation happens when a node becomes materialized (not on arbitrary key mention/lookups).
- `nodeKeyToId(nodeKey)` is an internal lookup helper and must not allocate for non-materialized nodes.
- if `nodeKeyToId(nodeKey)` is called for a non-materialized node, it returns missing (or equivalent lookup-miss error/value).
- the materialization write path is responsible for atomically inserting both graph-state records and id↔key entry.
- node deletion/de-materialization path is responsible for atomically removing both graph-state records and id↔key entry.
- `inputs`/`revdeps` may reference only materialized-node identifiers; they must never require lookup entries for non-materialized nodes.
- migration/render/scan/sync validation must fail fast if any graph-state id lacks a key entry, or if any key entry exists without materialized graph-state presence.

## Allocation and stability

Every materialized node has exactly one `NodeIdentifier`.

When a concrete `NodeKey` becomes materialized:

- if it already has an identifier, that identifier is reused
- otherwise a fresh identifier is allocated and recorded in both lookup sublevels

Recompute, invalidate, cache-hit, and migration-preserve flows keep the existing
identifier.

Delete removes:

- all graph-state records keyed by `id`
- `nodeKeyToId(nodeKey)`
- `nodeIdToKey(id)`

Migration preserves identifiers for `keep`, `override`, and `invalidate`, and allocates
fresh identifiers for `create`.

## Determinism

`revdeps` stores `NodeIdentifier[]` in ascending lexicographic order of the identifier
string itself.

`NodeKey` is not consulted when ordering reverse-dependency lists. All internal
sorting operates on `NodeIdentifier` values directly.

## Bijection cache

The full contents of the lookup table (`/${current_replica}/global/identifiers_keys_map`)
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

- `/${current_replica}/global/identifiers_keys_map`

The snapshot format therefore exposes graph-state records directly by identifier and
uses the lookup table for semantic readability.

## No key↔path conversion

Outside the explicit lookup-metadata table, there must not be any code whose job
is to convert concrete node keys to filesystem paths or to reconstruct concrete node
keys from filesystem paths.

This prohibition applies to graph-state addressing and covers both:

- dedicated helper functions for `NodeKey ↔ path` conversion used for graph-state
  files
- incidental logic embedded inside render/scan/unification code that reconstructs a
  concrete `NodeKey` from graph-state path segments or encodes one into graph-state
  path segments

The following lookup-metadata path is explicitly exempt from this prohibition:

- `/${current_replica}/global/identifiers_keys_map`

This path may encode or decode `NodeKey` values for the sole purpose of reading and
writing the lookup tables. They must not be treated as a general filesystem addressing
scheme for graph-state records.

Accordingly:

- graph-state filesystem paths are direct identifier paths
- scan consumes those direct identifier paths
- render writes those direct identifier paths
- any `NodeKey ↔ path` logic is limited to the lookup-metadata namespace above

## API invariants

- public `IncrementalGraph` methods remain semantic (`NodeKey` / `head + args`)
- `pull`, `invalidate`, `unsafePull`, `unsafeInvalidate`, `getValue`, `getFreshness`, and timestamp/inspection helpers are all semantic at the public boundary
- `IncrementalGraph` converts to `NodeIdentifier` immediately at method entry
- concrete-node read/write/recompute/invalidate/delete/inspection/storage operations below that boundary use `NodeIdentifier`
- `nodeKeyToId(nodeKey)` and `nodeIdToKey(id)` are internal translation helpers, not public graph-interface methods
- HTTP concrete-node routes remain semantic (`head + args`)
- migration APIs are identifier-based internally
- no mixed model below the boundary is allowed

## Invariants

For every materialized node identifier `id`:

1. `nodeIdToKey(id) = key`
2. `nodeKeyToId(key) = id`
3. all graph-state records for that node are keyed by `id`
4. every entry inside `inputs[id].inputs` is a valid `NodeIdentifier`
5. every entry inside `revdeps[id]` is a valid `NodeIdentifier`

No persisted graph edge may point directly to a `NodeKeyString`.

## Corruption conditions

The following states are invalid:

- `nodeKeyToId(key)` exists but `nodeIdToKey(id)` is missing
- `nodeIdToKey(id)` exists but `nodeKeyToId(key)` is missing
- lookup entries disagree about each other
- a graph-state record exists for an id with no `nodeIdToKey(id)` entry
- `inputs` or `revdeps` mention an unknown id
