# IncrementalGraph Journal 3 Types

## Primitive identities

```text
JournalAuthor   = DatabaseFingerprint
JournalSequence = positive arbitrary-precision integer

JournalRecordId = {
    author: JournalAuthor,
    sequence: JournalSequence
}

JournalFrontier = Map<JournalAuthor, JournalSequence>

AuthorityPhysicalTime = fixed-width non-negative epoch milliseconds
AuthorityLogicalTime  = non-negative arbitrary-precision integer
AuthorityTime = {
    physical: AuthorityPhysicalTime,
    logical: AuthorityLogicalTime
}
```

Missing coordinates in a `JournalFrontier` mean zero.

A journal writer stream for author `A` is a contiguous sequence:

```text
A:1, A:2, ..., A:n
```

No supported stream contains a hole. A local implementation may stage records temporarily, but a committed supported journal exposes only complete prefixes.

## Journal replica

A retained journal replica is conceptually:

```text
JournalReplica = Map<JournalAuthor, Array<JournalRecord>>
```

where each array is exactly the immutable prefix named by the replica frontier.

The physical LevelDB layout is implementation-defined. It should permit ordered per-author range iteration without materializing the whole journal in RAM.

A supported journal replica satisfies:

1. record `(A,q)` is stored under writer `A` and has `id.author == A`, `id.sequence == q`;
2. for every retained writer `A`, records exist for every sequence from `1` through `frontier[A]`;
3. two structures claiming the same `JournalRecordId` have byte-for-byte equivalent canonical record meaning;
4. semantic-event contexts are causally covered by the retained frontier.

## Record classes

Journal 3 distinguishes semantic events from non-semantic writer-state/history records.

```text
JournalRecord = SemanticEvent | WriterStateRecord
```

High-level operation grouping may be added as another immutable record class later. It is not required for core replay.

Every record has one writer-local stream identity:

```text
JournalRecordBase = {
    id: JournalRecordId
}
```

Every local record, including non-semantic writer-state records, consumes the next writer-stream sequence. Therefore `sequence` is fundamentally a writer-local log position, not a count of semantic value changes.

## Semantic event reference

Semantic events additionally carry exact causal and conflict-authority metadata:

```text
EventRef = {
    id: JournalRecordId,
    context: JournalFrontier,
    authorityTime: AuthorityTime
}
```

The `context` and `authorityTime` of a semantic event are immutable parts of that event's identity/meaning.

Two retained semantic-event representations which claim the same `id` must agree on:

- `context`;
- `authorityTime`;
- `node`;
- event kind; and
- every kind-specific body field.

Disagreement is unsupported/corrupt state, not a conflict to resolve by authority ordering.

## Value identity

```text
ValueId = JournalRecordId
```

A `ValueId` is valid only when its record is a `ValueEvent`.

One `ValueId` identifies exactly one immutable semantic value occurrence at one semantic `NodeKey`.

## Timestamp representation

Journal timestamps use canonical whole-millisecond epoch instants.

```text
CreationTime = fixed-width canonical epoch-millisecond instant
ModifiedTime = fixed-width canonical epoch-millisecond instant
```

The canonical conversion from the legacy timestamp string is pure and timezone-independent. Supported Journal 3 state rejects malformed timestamps, sub-millisecond timestamps which cannot be represented exactly, and timestamp pairs with:

```text
createdAt > modifiedAt
```

Physical time is treated as fixed-width for the repository's asymptotic accounting; journal-history growth is represented by sequence/HLC logical coordinates instead.

## Semantic event base

```text
SemanticEventBase = JournalRecordBase & {
    context: JournalFrontier,
    authorityTime: AuthorityTime,
    node: NodeKey
}
```

The core event kinds are:

```text
SemanticEvent =
    | ValueEvent
    | DeleteEvent
    | ValidateEvent
    | InvalidateEvent
```

## ValueEvent

```text
ValueEvent = SemanticEventBase & {
    kind: "value",
    nodeIdentifier: NodeIdentifier,
    payload: ComputedValue,
    createdAt: CreationTime,
    modifiedAt: ModifiedTime,
    reason: "compute" | "bootstrap" | "reset" | "migration"
}
```

The `ValueEvent.id` is the `ValueId` of this exact value occurrence.

A value event is replay-complete: replay must not read the mutable legacy `values` or `timestamps` sublevels in order to discover the payload or timestamps represented by this occurrence.

For one continuing materialization lineage, a local semantic value replacement normally carries the existing `createdAt` into the new value event while giving the new occurrence its own `modifiedAt`. Deletion ends that materialization lineage. A later materialization from semantic absence receives a new `createdAt` according to the ordinary graph timestamp rules.

If synchronization copies a foreign value occurrence, it copies the original immutable `ValueEvent` rather than creating a new local `ValueEvent` merely to transport that value.

## DeleteEvent

```text
DeleteEvent = SemanticEventBase & {
    kind: "delete",
    reason: "operation" | "reset" | "migration" | "sync"
}
```

A delete event is semantic absence authority for its `node`.

Deletion does not erase historical value events or their payloads. Replay can therefore inspect or reconstruct earlier node history while selecting the delete event as the current head when its authority wins.

## Validation basis

For concrete node `K`, let the fixed schema determine ordered distinct direct semantic input edges:

```text
inputEdges(K) = [D0, D1, ...]
```

The basis has one entry per direct input:

```text
BasisEntry = ValueId | "unknown"
ValidationBasis = Array<BasisEntry>
```

A normal Journal-3-native validation records the exact current `ValueId` for every direct input. The `"unknown"` sentinel exists only for controlled bootstrap/reset/migration baselines which must reproduce a legacy missing incoming proof but do not possess the historical value occurrence against which that proof was last absent.

`"unknown"` never equals any current `ValueId`. It therefore reconstructs a missing validity edge without inventing provenance.

The basis length and order must exactly match `inputEdges(K)`.

## ValidateEvent

```text
ValidateEvent = SemanticEventBase & {
    kind: "validate",
    value: ValueId,
    basis: ValidationBasis,
    reason: "compute" | "unchanged" | "cache-revalidate" | "bootstrap" | "reset" | "migration"
}
```

A validation applies only to the named value occurrence.

A local value-changing computation normally authors its `ValueEvent` before its matching `ValidateEvent`, and the validation context includes the value event.

A successful computation which preserves the current semantic value does not author another `ValueEvent`; it authors a new `ValidateEvent` for the existing `ValueId`.

## Invalidation scope

```text
InvalidateScope =
    | { kind: "node" }
    | { kind: "value", value: ValueId }
```

Node-scoped invalidation is independent of a particular selected value occurrence. It is used when the named node itself has been explicitly/directly invalidated and its incoming cache proof must not be accepted until a later validation has observed that invalidation.

Value-scoped invalidation marks one particular cached value occurrence stale without changing its value identity. It is used for persistent freshness transitions such as propagated invalidation or synchronization normalization where the incoming proof relation itself is not removed.

## InvalidateEvent

```text
InvalidateEvent = SemanticEventBase & {
    kind: "invalidate",
    scope: InvalidateScope,
    reason: "explicit" | "propagated" | "sync" | "bootstrap" | "reset" | "migration"
}
```

The `reason` is historical/debugging metadata. Projection semantics are determined by `scope`, event causality, and the selected value/certificate history.

## WriterStateRecord

Some current persisted graph metadata is host-local allocator state rather than cross-replica semantic graph authority. Journal 3 nevertheless records it so same-host replay can reconstruct the complete supported persisted database state without consulting the old mutable value.

Core Journal 3 defines:

```text
WriterStateRecord = JournalRecordBase & {
    kind: "writer-state",
    lastNodeIndex: non-negative integer
}
```

A writer-state record belongs to its author's local stream and records that author's durable `last_node_index` watermark after the publication which contains it.

`lastNodeIndex` is monotone within one continuing writer stream. Foreign writer-state records are retained for historical completeness but do not replace the receiver's own host-local `last_node_index`.

A publication which durably advances the local allocation watermark must include a writer-state record carrying the new watermark unless the same value is already reconstructible from a later record in the same atomic publication. The replay rule is defined in `incremental-graph-journal-replay.md`.

## Causal context

For distinct semantic events `E` and `F`:

```text
happenedBefore(E,F) iff
    E.id.author == F.id.author
        ? E.id.sequence < F.id.sequence
        : E.id.sequence <= F.context[E.id.author]
```

The same-writer relation uses stream sequence even though non-semantic records may occur between two semantic events. This is valid because stream order is the writer's durable publication order.

A semantic event context is the complete journal frontier causally observed by the author before that event is published, extended within one atomic publication by earlier same-publication records/events as appropriate.

For every semantic event `E`:

```text
E.context[E.id.author] < E.id.sequence
```

and a supported retained journal covers every coordinate in `E.context`.

## Authority clock

Each writable replica maintains a derived/cached authority-clock high-water value equal to at least the greatest `AuthorityTime` among semantic events it has causally observed.

Before authoring a local semantic event, let `seedPhysical` be:

- the event's exact `modifiedAt` for `ValueEvent`;
- the operation/publication wall-clock instant for other locally authored semantic events.

Let `H` be the current observed authority high-water. Allocate:

```text
p = max(seedPhysical, H.physical)

if p > H.physical:
    nextAuthorityTime = { physical: p, logical: 0 }
else:
    nextAuthorityTime = {
        physical: p,
        logical: H.logical + 1
    }
```

The event receives `nextAuthorityTime` and the local high-water advances to it.

The persisted/cached high-water is an acceleration/allocator state, not independent replay authority: it can be recomputed as the maximum authority time of retained semantic history.

Journal 3 imposes no maximum-clock-skew rejection rule.

## Total semantic authority order

Conflict selection uses this total order over semantic `EventRef`s:

```text
authorityCompare(E,F):
    compare E.authorityTime.physical numerically;
    on equality compare E.authorityTime.logical numerically;
    on equality compare E.id.author lexicographically;
    on equality compare E.id.sequence numerically
```

The final sequence comparison occurs only after writer identity is equal.

Because an author joins all causally observed authority high-water state before allocating a later semantic event:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

for supported semantic events.

Concurrent events are deterministically ordered by authority time and then writer identity. This is conflict precedence, not a claim that one concurrent event physically happened later in real time.

## Record publication ordering

When one atomic graph operation produces multiple records, it allocates consecutive writer-stream positions in a deterministic order which extends semantic happened-before requirements.

At minimum:

- a new `ValueEvent` precedes every `ValidateEvent` naming that new `ValueId`;
- a direct invalidation/value change precedes any locally authored propagated invalidation caused by it;
- an event must never reference a same-publication `ValueId` or other semantic record allocated after it.

Records not ordered by semantic dependency use a stable operation-specific tie-breaker, normally canonical `NodeKey` and record kind.

## Journal frontier join

For two compatible journal frontiers `F` and `G`:

```text
join(F,G)[A] = max(F[A], G[A])
```

The numerical frontier join alone is meaningful only when the corresponding immutable records are available and agree on overlapping IDs.

For causally closed immutable-prefix journals, union of the actual records corresponding to this componentwise maximum is again causally closed.

This prefix-union operation is idempotent, commutative, and associative at the journal-information level.
