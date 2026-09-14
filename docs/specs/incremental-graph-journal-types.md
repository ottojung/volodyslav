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

Missing frontier coordinates mean zero.

A writer A owns one contiguous stream:

```text
A:1, A:2, ..., A:n
```

A supported committed stream contains no holes.

## Retained JournalReplica

Conceptually:

```text
JournalReplica = Map<JournalAuthor, Array<JournalRecord>>
```

where every array is exactly one immutable prefix.

The physical key/value layout is implementation-defined, but it must support ordered per-writer range iteration without requiring the complete journal in RAM.

A supported retained journal satisfies:

1. record `(A,q)` has `id.author == A` and `id.sequence == q`;
2. for every retained A, every sequence `1..frontier[A]` exists;
3. one `JournalRecordId` has one canonical immutable meaning;
4. every retained semantic-event context is covered by the retained frontier;
5. all record versions are decodable under the current supported interpretation.

## Record version

Every persisted Journal 3 record carries an explicit format discriminator:

```text
JournalRecordVersion = positive integer
```

The initial Journal 3 persisted format uses:

```text
recordVersion = 1
```

`recordVersion` selects the immutable record codec/meaning for that record. Future versions may add a decoder/upcaster, but may not destructively rewrite an existing `(author,sequence)` into new meaning.

A pure upcaster converts one historical record representation into the current in-memory semantic model without external I/O, clock reads, computor calls, migration callbacks, or changing the historical fact represented by that ID.

## Record classes

Core Journal 3 records are:

```text
JournalRecord = SemanticEvent | WriterStateRecord
```

High-level operation/tracing records may be added later as additional immutable non-semantic record classes.

Every record starts with:

```text
JournalRecordBase = {
    recordVersion: JournalRecordVersion,
    id: JournalRecordId
}
```

All local record classes consume writer-local stream positions. Therefore `JournalSequence` is a log coordinate, not a count of semantic value changes.

## Semantic EventRef

Semantic events additionally carry:

```text
EventRef = {
    id: JournalRecordId,
    context: JournalFrontier,
    authorityTime: AuthorityTime
}
```

`context` and `authorityTime` are immutable event meaning.

Two representations claiming one semantic event ID must agree on:

- record version/decoded meaning;
- context;
- authority time;
- node;
- event kind;
- every kind-specific body field.

Disagreement is a writer fork/corruption error, not a graph conflict.

## Value identity

```text
ValueId = JournalRecordId
```

A `ValueId` is valid only when its record decodes to a `ValueEvent`.

One ValueId denotes exactly one immutable semantic value occurrence for one semantic `NodeKey`.

Payload equality never creates ValueId equality.

## Timestamp representation

```text
CreationTime = fixed-width canonical whole-millisecond epoch instant
ModifiedTime = fixed-width canonical whole-millisecond epoch instant
```

Canonical conversion from legacy timestamp strings is pure/timezone-independent.

Supported records reject malformed or non-exactly-representable timestamps and value occurrences with:

```text
createdAt > modifiedAt
```

Physical time is fixed-width for asymptotic accounting. History growth appears in journal sequence and HLC logical coordinates.

## SemanticEventBase

```text
SemanticEventBase = JournalRecordBase & {
    context: JournalFrontier,
    authorityTime: AuthorityTime,
    node: NodeKey
}
```

Core semantic events are:

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

`ValueEvent.id` is the exact ValueId.

The event is replay-complete: replay must not read mutable `values`/`timestamps` to discover this occurrence's payload/timestamps.

For a continuing materialization lineage, local semantic replacement normally preserves the current `createdAt` and `NodeIdentifier` while creating a new payload/`modifiedAt` occurrence.

Deletion ends that materialization lineage. Later materialization from semantic absence follows ordinary graph rules for a new creation time/identifier allocation.

Synchronization copies a foreign ValueEvent unchanged. Receipt does not create another local ValueEvent.

Reset/migration may intentionally create new baseline ValueEvents carrying an already-existing physical NodeIdentifier and target payload/timestamps; those new event IDs are distinct new semantic occurrences.

## DeleteEvent

```text
DeleteEvent = SemanticEventBase & {
    kind: "delete",
    reason: "operation" | "reset" | "migration" | "sync"
}
```

DeleteEvent is semantic absence authority for its NodeKey.

It never erases old ValueEvents/payloads from history.

## Validation basis

For concrete K, let current schema define ordered distinct direct semantic edges:

```text
inputEdges(K) = [D0, D1, ...]
```

A certificate basis has one entry per edge:

```text
BasisEntry = ValueId | "unknown"
ValidationBasis = Array<BasisEntry>
```

A normal Journal-3-native validation records the exact current ValueId for every direct input.

`"unknown"` is restricted to controlled bootstrap/reset/migration baselines which must reproduce an intentionally missing legacy validity proof when the historical occurrence against which that proof was absent is unavailable.

`"unknown"` never equals a ValueId and therefore produces no incoming validity edge.

Basis order/length must exactly match `inputEdges(K)` under the interpretation that authored the baseline/current state.

## ValidateEvent

```text
ValidateEvent = SemanticEventBase & {
    kind: "validate",
    value: ValueId,
    basis: ValidationBasis,
    reason: "compute" | "unchanged" | "cache-revalidate" | "bootstrap" | "reset" | "migration"
}
```

A validation applies only to its named value occurrence.

Its `value` must name a retained ValueEvent for the same semantic node.

Every non-unknown basis entry must name a retained ValueEvent for the corresponding direct input semantic node.

A newly computed changed value normally authors its ValueEvent before this ValidateEvent. `Unchanged`/cache revalidation author a new validation for the existing ValueId without a new ValueEvent.

## Invalidation scopes

```text
InvalidateScope =
    | { kind: "node" }
    | { kind: "value", value: ValueId }
```

### Node scope

Node-scoped invalidation is independent of the selected value occurrence.

It represents direct/explicit invalidation of the node's incoming cache proof. A validation clears its effect only when the validation causally observes/covers that invalidation.

### Value scope

Value-scoped invalidation marks one exact cached occurrence stale without removing its incoming validity proof by itself.

It represents persistent freshness transitions such as propagated invalidation, synchronization propagation, or stale baseline state.

It stops applying when another ValueId becomes the selected current occurrence.

## InvalidateEvent

```text
InvalidateEvent = SemanticEventBase & {
    kind: "invalidate",
    scope: InvalidateScope,
    reason: "explicit" | "propagated" | "sync" | "bootstrap" | "reset" | "migration"
}
```

`reason` is historical/debugging classification. Replay behavior comes from scope, causality, selected value, and certificates.

A value-scoped invalidation must name a retained ValueEvent for the same semantic node.

## WriterStateRecord

Host-local allocation metadata must also be replayable.

Core Journal 3 defines:

```text
WriterStateRecord = JournalRecordBase & {
    kind: "writer-state",
    lastNodeIndex: non-negative integer
}
```

A writer-state record is authored only in its own writer stream.

For one continuing writer, `lastNodeIndex` records are monotone nondecreasing.

Foreign writer-state records are retained/relayed but never replace the receiver's own `last_node_index`.

When a local publication durably advances the local allocation watermark, that publication records a writer-state value sufficient for replay to reconstruct the resulting watermark.

## Causal context

For distinct semantic events E and F:

```text
happenedBefore(E,F) iff
    E.id.author == F.id.author
        ? E.id.sequence < F.id.sequence
        : E.id.sequence <= F.context[E.id.author]
```

Same-writer semantic order follows immutable writer-stream order even when non-semantic records lie between two events.

A semantic event's context is the complete retained journal frontier causally observed before that event, extended to include earlier same-publication records as appropriate.

For semantic E:

```text
E.context[E.id.author] < E.id.sequence
```

and every coordinate in E.context must be retained in a supported journal.

## Ordinary authority allocation

Each writable database maintains/derives an observed semantic-authority high-water H equal to at least the greatest `AuthorityTime` among semantic events it has observed.

For an ordinary new semantic event choose `seedPhysical`:

- exact `modifiedAt` for ValueEvent;
- operation/publication wall-clock instant for other events.

Allocate:

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

Then advance H to at least that authority.

The cached high-water is derived allocator state, not independent semantic authority. It can be reconstructed from retained semantic events.

Journal 3 imposes no maximum-clock-skew rejection rule.

## Initial-bootstrap ValueEvent authority exception

Only the initial pre-Journal-3 bootstrap baseline defined by `incremental-graph-journal-migrations.md` may allocate bootstrap ValueEvents with:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

without incrementing H for every equal-time bootstrap value.

This exception is valid only because:

1. bootstrap ValueEvents are allocated before later bootstrap semantic events;
2. they are enumerated in nondecreasing modifiedAt order;
3. equal-time same-writer events remain strictly ordered by writer-local sequence in the total EventRef authority order;
4. later bootstrap Validate/Invalidate events return to ordinary HLC allocation after H has been raised to the maximum bootstrap value authority/time.

No ordinary pull, sync, reset, or later migration may use this exception.

## Total semantic authority order

Conflict precedence compares EventRefs by:

```text
authorityCompare(E,F):
    1. authorityTime.physical numerically
    2. authorityTime.logical numerically
    3. id.author lexicographically
    4. id.sequence numerically
```

Sequence is compared only after author equality (because distinct writers have distinct author strings at step 3).

For every supported pair:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

Ordinary HLC allocation guarantees this across observed writers and unequal/successive authority coordinates; bootstrap's equal-time same-writer case is completed by step 4.

Concurrent events are deterministically ordered by this rule. The order is conflict authority, not guaranteed real-world chronology.

## Publication ordering

One atomic local publication allocates a contiguous writer sequence range in deterministic order extending semantic dependency/happened-before constraints.

At minimum:

- a ValueEvent precedes each same-publication ValidateEvent naming its new ValueId;
- a root/direct change precedes propagated invalidations caused by it;
- a dependency structural deletion precedes dependent deletions authored solely because of that absence;
- a record never references a same-publication record allocated after it.

When semantics do not constrain two records, use a stable operation-specific ordering, normally canonical NodeKey then record kind.

Final sequence allocation occurs during serialized publication finalization as defined by the Journal API/locking specs, so failed transactions leave no durable holes.

## Frontier join

For compatible frontiers F and G:

```text
join(F,G)[A] = max(F[A], G[A])
```

A numerical frontier is meaningful only together with actual immutable records through every coordinate.

If two causally closed prefix journals have agreeing overlap, the union represented by the componentwise max is causally closed.

At retained-information level, compatible prefix union is:

- idempotent;
- commutative;
- associative.
