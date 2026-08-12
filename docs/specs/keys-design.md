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

- **NodeKey**: the canonical semantic identity of a concrete node instance,
  derived from `(head, args)`; in implementation documents `NodeKeyString`
  denotes its serialized representation where a string representation is needed
- **NodeIdentifier**: the deterministic persisted identifier attached to a materialized node
- **graph-state sublevels**: `values`, `freshness`, `valid`,
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
- Migration-produced `valid` must contain only `NodeIdentifier` values.
- Migration control decisions (`keep`, `override`, `invalidate`, `create`, `delete`) operate on `NodeIdentifier`-addressed state, with `NodeKey` used only via the lookup bijection when needed for schema/head filtering or inspection.

There is no mixed-mode migration API: `NodeKey`-addressed migration payloads are out of scope and unsupported.

### HTTP inspection API

HTTP concrete-node routes remain `head + args` based to preserve existing API behavior.

- Route addressing remains semantic (`head + args`).
- Handlers call the public graph API in semantic form.
- Identifier conversion happens inside `IncrementalGraph` at the same boundary as non-HTTP callers.
- `NodeIdentifier` is not exposed as required request-addressing for public graph routes.

## NodeIdentifier requirements

A `NodeIdentifier` is a deterministic, globally-namespaced identifier with the
following properties:

- globally and forever unique
- stable for the lifetime of that materialized node in storage
- round-trippable as a nominal type
- suitable for direct use as persisted key content and as a filesystem path segment
- matches `/^[0-9a-z]+-[a-z]{16}$/` (full-string match)

### Format

```
<base36-local-node-index>-<fingerprint>
```

- The index prefix is a base36 integer (characters `0-9a-z`), no padding or alignment.
- The `DatabaseFingerprint` is exactly 16 lowercase ASCII letters
  (`[a-z]{16}`).
- The separator is a single hyphen `-`.

### Character set

Allowed characters in a `NodeIdentifier`:

- lowercase ASCII letters `a-z`
- digits `0-9`
- hyphen `-` (as separator between index and fingerprint)

No other characters are permitted. In particular, a
`NodeIdentifier` MUST NOT contain `/`, `\`, `.`, whitespace, control characters, `!`,
or any other punctuation besides the single separator hyphen.

### Format is specification-only

The format regex `/^[0-9a-z]+-[a-z]{16}$/` is a specification invariant only.
Runtime code does not validate the documented format at internal conversion
boundaries. Every identifier in the system originates from `makeNodeIdentifier()`,
which assembles it from components that are valid by construction (a fingerprint
validated at lifecycle boundaries and a local allocation index). No supported
lifecycle transition introduces externally-sourced identifier strings (see
`docs/specs/database-lifecycle.md` §4, §5, §11–12), so runtime validation at
internal boundaries would be redundant.

### Example values

- `1-abcdefghijklmnop`
- `2-abcdefghijklmnop`
- `z-abcdefghijklmnop`
- `10-abcdefghijklmnop`

### Allocation

Identifiers are allocated as `${nextIndex.toString(36)}-${fingerprint}` where
`nextIndex` is a monotonic counter starting at `1` and `fingerprint` is the
machine-local database fingerprint (see `docs/specs/incremental-graph-fingerprint.md`).

Gaps in the index sequence are acceptable (caused by failed or interleaved
transactions). The `last_node_index` watermark tracks the largest committed index.

## Persisted storage model

All persisted graph state addresses nodes by `NodeIdentifier`, not by `NodeKeyString`.

This applies to:

- keys in all graph-state sublevels
- values inside `valid`
- all migration callback payloads and migration-produced state
- filesystem-rendered snapshots

### Graph-state sublevels

- `values[id] -> ComputedValue`
- `freshness[id] -> Freshness`
- `timestamps[id] -> TimestampRecord`
- `valid[id] -> NodeIdentifier[]`

### Storage invariants

- graph-state sublevel keys are `NodeIdentifier`
- `valid[id]` contains `NodeIdentifier[]`
- validity sets are sorted by `NodeIdentifier` (lexicographic), never by `NodeKey`
- render/scan paths use direct identifier path segments
- graph-state path encoding/decoding must not reconstruct `NodeKey` values
- `NodeKey` and `NodeKeyString` MUST NOT address graph-state sublevels or occur
  inside graph validity/storage structures

Persistent semantic keys are permitted only in explicit semantic-identity
metadata whose contract requires them:

- `identifiers_keys_map`, as the materialized-node identity bijection; and
- immutable `JournalEntry.key`, as retained semantic journal history.

The second location does not make journal entries graph state and does not
restore key-addressed graph records. In particular, `values[id]`,
`freshness[id]`, `timestamps[id]`, and `valid[id]` remain exclusively
`NodeIdentifier`-addressed.

### Lookup metadata

The database contains an explicit bijection between the semantic identity and the
persisted identity:

- `nodeKeyToId(nodeKey) -> id`
- `nodeIdToKey(id) -> nodeKey`

These functions operate on the `/${current_replica}/global/identifiers_keys_map` database value.
Here `${current_replica}` is the replica name of the current database instance, for example `x` or `y`.

Within graph storage, `NodeKeyString` may remain persisted only in this lookup
table at `/${current_replica}/global/identifiers_keys_map`. The journal's
separate permitted use is `JournalEntry.key`; it is semantic history rather
than graph-state addressing.

The map is the materialized-node identity table, with a strict invariant:

1. contains every materialized node;
2. contains only materialized nodes.

Lifecycle rules:

- `NodeIdentifier` allocation happens when a node becomes materialized (not on arbitrary key mention/lookups).
- `nodeKeyToId(nodeKey)` is an internal lookup helper and must not allocate for non-materialized nodes.
- if `nodeKeyToId(nodeKey)` is called for a non-materialized node, it returns missing (or equivalent lookup-miss error/value).
- the materialization write path is responsible for atomically inserting both graph-state records and id↔key entry.
- node deletion/de-materialization path is responsible for atomically removing both graph-state records and id↔key entry.
- `valid` may reference only materialized-node identifiers; it must never require lookup entries for non-materialized nodes.
- migration/render/scan/sync validation must fail fast if any graph-state id lacks a key entry, or if any key entry exists without materialized graph-state presence.

## Allocation and stability

Every materialized node has exactly one `NodeIdentifier`.

When a concrete `NodeKey` becomes materialized:

- if it already has an identifier, that identifier is reused
- otherwise a fresh identifier is allocated using the current local node index
  and the database fingerprint: `${nextIndex.toString(36)}-${fingerprint}`
- the new identifier is recorded in both lookup sublevels and the
  `last_node_index` watermark is advanced

Recompute, invalidate, cache-hit, and migration-preserve flows keep the existing
identifier.

Delete removes:

- all graph-state records keyed by `id`
- `nodeKeyToId(nodeKey)`
- `nodeIdToKey(id)`

It does not remove retained journal entries carrying that `NodeKey`.

Migration preserves identifiers for `keep`, `override`, and `invalidate`, and allocates
fresh identifiers for `create` using the same fingerprint/index scheme.

## Canonical, reversible semantic identity

For every valid semantic node instance, a compliant `NodeKey` is self-contained:
it deterministically recovers the same `NodeName` and binding environment. The
physical encoding is implementation-defined, but an operation equivalent to
`decodeNodeKey` MUST satisfy:

```text
decodeNodeKey(makeNodeKey(nodeName, bindings)) ==semantic
    { nodeName, bindings }
```

Semantic equality means the same `NodeName`, equal binding lengths, and
`isEqual(decoded.bindings[i], bindings[i])` at every position. Decoding MUST NOT
consult `identifiers_keys_map`, a `NodeIdentifier`, or current materialization
state.

For any valid node instances A and B:

```text
A ==semantic B  iff  NodeKey(A) == NodeKey(B)
```

Thus semantically equal instances produce the same canonical key and
semantically unequal instances produce different keys, including when bindings
contain nested arrays or records. Equality here is key-value equality, never
JavaScript object identity. Journal same-key grouping, per-key history,
`presenceHead(K)`, `candidateEvents(K)`, `notificationWitness(K)`, and
compaction coordinates rely on this equivalence.

Once K is persisted in supported journal history, every later supported
implementation and database migration MUST decode K as exactly the same
`(nodeName, bindings)`. A migration MUST NOT silently reinterpret K or rewrite
an immutable `JournalEntry.key` merely because an internal encoding changes.
Supported future implementations therefore preserve decoding compatibility for
persisted keys. Deliberately changing the encoding requires a separately
specified compatibility/versioning mechanism.

Authoring a journal entry MUST take a deep semantic snapshot of its `NodeKey`,
or otherwise guarantee equivalent isolation, so no caller-owned array or record
remains a mutable alias. The key and every publicly reachable nested value are
immutable for the entry's lifetime. Remote import preserves that same logical
key unchanged.

### De-materialization trace

```text
K = NodeKey(foo, [{ id: 7 }])

t1:
    K is materialized
    identifiers_keys_map contains K <-> N
    the journal retains E with E.key = K

t2:
    K is de-materialized
    graph-state records for N are deleted
    the identifiers_keys_map entry for K/N is deleted
    E remains retained

later:
    possibleMaybeChanges() processes E
    decodeNodeKey(E.key)
        -> nodeName = foo
        -> bindings = [{ id: 7 }]
```

The last step uses no `NodeIdentifier`, `identifiers_keys_map`, or current graph
materialization. A `NodeIdentifier` is the storage identity of a materialization
and may disappear with it; a `NodeKey` is semantic identity and may outlive it
in journal history. Synchronization may reconcile identifiers without changing
the key, and `JournalEntry.key` is never derived from a selected identifier.

### Current encoding audit

The current implementation serializes `{head,args}` with JSON. That byte layout
is not normative. It round-trips ordinary finite numbers, strings, booleans,
arrays, and records, but it does not yet satisfy the complete contract above:

- record property insertion order affects `JSON.stringify`, although
  `isEqual` treats records with the same properties as equal, so serialization
  is not canonical for those values; and
- the declared `ConstValue` number domain does not exclude `NaN`, positive
  infinity, or negative infinity. JSON converts these values to `null`, which
  is not injective and changes semantic identity.

These are implementation gaps to be closed when the target NodeKey contract is
implemented. They do not narrow or redefine `ConstValue`, and they do not make
today's JSON representation normative.

### last_node_index

The `last_node_index` watermark (see `docs/specs/incremental-graph-last-node-index.md`)
is stored at the active replica's global sublevel under the key `"last_node_index"`.
It is a monotonic allocation watermark, not a node count. Gaps are acceptable.

## Determinism

`valid` stores `NodeIdentifier[]` in ascending lexicographic order of the identifier
string itself.

`NodeKey` is not consulted when ordering validity lists. All internal
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
- `rendered/r/valid/nodeid1`
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
4. every entry inside `valid[id]` is a valid `NodeIdentifier`

No persisted graph edge may point directly to a `NodeKeyString`.

## Corruption conditions

The following states are invalid:

- `nodeKeyToId(key)` exists but `nodeIdToKey(id)` is missing
- `nodeIdToKey(id)` exists but `nodeKeyToId(key)` is missing
- lookup entries disagree about each other
- a graph-state record exists for an id with no `nodeIdToKey(id)` entry
- `valid` mentions an unknown id
