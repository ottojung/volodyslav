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
3. one `JournalRecordId` has one canonical historical meaning;
4. every retained semantic-event context is covered by the retained frontier;
5. every retained record is encoded in the one canonical format selected by the replica's current `global/version`.

## Single current record format

Journal records do not carry a per-record format/version discriminator.

The existing database `global/version` value selects the representation of the entire active replica, including journal records and journal-derived metadata. A supported current replica therefore never contains a mixture of old/new journal record formats and ordinary replay never upcasts or downcasts individual records.

A version migration which changes journal representation rewrites every retained record into the target version's canonical format before target cutover. That rewrite may change/add/remove representation fields, but for every pre-existing record it preserves:

- `JournalRecordId`;
- the historical semantic fact represented by that ID;
- causal context/authority meaning;
- ValueId and other cross-record reference identity.

The old active replica and the inactive migration target may temporarily use different whole-database formats while migration is in progress. Each replica itself remains homogeneous.

## Record classes

Core Journal 3 records are:

```text
JournalRecord = SemanticEvent | WriterStateRecord
```

High-level operation/tracing records may be added later as additional immutable non-semantic record classes.

Every record starts with:

```text
JournalRecordBase = {
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

Two current-format representations claiming one semantic event ID must agree on:

- context;
- authority time;
- node;
- event kind;
- every kind-specific semantic field.

Disagreement is a writer fork/corruption error, not a graph conflict.

## Value identity

```text
ValueId = JournalRecordId
```

A `ValueId` is valid only when its record is a `ValueEvent`.

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

## NodeIdentifier uniqueness basis

Journal 3 relies on the existing NodeIdentifier allocation contract rather than establishing uniqueness by rescanning historical ValueEvents.

Conceptually a locally allocated NodeIdentifier combines:

```text
(DatabaseFingerprint, strictly increasing local allocation index)
```

The database-fingerprint intent explicitly accepts the negligible probability of two independently-created hosts receiving the same fingerprint. Within one continuing fingerprint namespace, the durable `last_node_index` allocation watermark never moves backward and an allocated/retired local index is never reused.

Therefore NodeIdentifiers are treated as globally and forever unique under the project's accepted fingerprint-collision assumption plus monotone local allocation.

Same-writer restoration and migration must preserve/reconstruct the allocator watermark before that writer may allocate again. Observable current reuse of one physical identifier for incompatible semantic nodes remains corruption, but historical replay does not need a second independent uniqueness mechanism beyond the allocator/fingerprint invariant.

## DeleteEvent

```text
DeleteEvent = SemanticEventBase & {
    kind: "delete",
    reason: "operation" | "reset" | "migration" | "sync"
}
```

DeleteEvent is semantic absence authority for its NodeKey.

It never erases old ValueEvents/payloads from history.

## Self-describing validation basis

A replay log must preserve what one historical validation actually claimed without requiring future software to recover the graph schema which happened to be active when that validation was authored.

Therefore validation bases name semantic input nodes explicitly:

```text
ValidationBasisValue = ValueId | "unknown"

ValidationBasisEntry = {
    input: NodeKey,
    value: ValidationBasisValue
}

ValidationBasis = Array<ValidationBasisEntry>
```

A basis has at most one entry for each semantic input NodeKey.

For a normal Journal-3-native validation under current schema with distinct direct edges:

```text
inputEdges(K) = [D0, D1, ...]
```

its basis contains exactly one entry for every current direct input:

```text
[
    { input: D0, value: currentValueId(D0) },
    { input: D1, value: currentValueId(D1) },
    ...
]
```

The displayed `D0,D1,...` order is illustrative only.

### Canonical NodeKey order

For the current database format, persisted `ValidationBasis` entries are ordered by the canonical persisted semantic identity of their NodeKey:

```text
nodeKeyOrder(A,B) =
    lexicographicCompare(
        nodeKeyStringToString(serializeNodeKey(A)),
        nodeKeyStringToString(serializeNodeKey(B))
    )
```

using the same JavaScript string lexicographic ordering as the current `compareNodeKeyStringByNodeKey` storage comparator.

This is deliberately the order of canonical persisted `NodeKeyString` identities, not the separate typed `compareNodeKey()` ordering. The ordering is independent of graph-schema input position.

If a future database version changes NodeKey representation/order, migration rewrites all retained affected journal records into that version's one canonical representation; current replay is not required to retain an eternal per-record v1 ordering rule.

Replay meaning is keyed by the explicit `input` NodeKey. Canonical NodeKey ordering gives one stable serialization/meaning for the current database representation without possessing the historical schema that authored the certificate.

The current schema is used separately to determine whether the certificate's explicit input-key set is complete/applicable to the current node interpretation.

`"unknown"` is restricted to controlled bootstrap/reset/migration baselines which must reproduce an intentionally missing legacy validity proof when the exact historical occurrence against which that proof was absent is unavailable.

`"unknown"` never equals a ValueId and therefore produces no incoming validity edge.

A normal compute/unchanged/cache-revalidate certificate must not use `"unknown"`.

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

Its `value` must name a retained ValueEvent for the same semantic node and must causally precede the validation as specified by `incremental-graph-journal-well-formedness.md`.

Every non-unknown basis entry must name a causally prior retained ValueEvent whose semantic node equals that entry's explicit `input` NodeKey.

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

A value-scoped invalidation must name a causally prior retained ValueEvent for the same semantic node.

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
- every same-publication input ValueEvent referenced by a validation basis precedes that validation;
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