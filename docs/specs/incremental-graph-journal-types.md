# IncrementalGraph Journal 2 Types

## Primitive identities

```text
JournalAuthor            = DatabaseFingerprint
JournalSequence          = positive arbitrary-precision integer
JournalIncarnation       = positive arbitrary-precision integer
JournalEventId           = { author: JournalAuthor, sequence: JournalSequence }
CausalPrefix             = Map<JournalAuthor, JournalSequence>
LocalOperationSequence   = positive arbitrary-precision integer
OperationId              = {
    author: JournalAuthor,
    incarnation: JournalIncarnation,
    sequence: LocalOperationSequence
}
```

Missing coordinates in a `CausalPrefix` mean zero.

A journal cursor is meaningful only inside one `(sourceFingerprint, incarnation)` pair.

## Lamport-compatible allocation

Every writable database persists:

```text
localJournalCounter   : JournalSequence | 0
localOperationCounter : LocalOperationSequence | 0
causalSummary         : CausalPrefix
journalIncarnation    : JournalIncarnation
```

Before authoring a local **semantic journal event**, allocate:

```text
nextSequence = 1 + max(
    localJournalCounter,
    every coordinate in causalSummary
)
```

and use:

```text
id = { author: localFingerprint, sequence: nextSequence }
context = causalSummary before publication
```

After publication, `localJournalCounter = nextSequence` and `causalSummary[localFingerprint] >= nextSequence`.

Multiple semantic events in one atomic transaction receive increasing local sequences in a deterministic order and each later event observes the earlier event.

High-level operation IDs use the separate `localOperationCounter`. Allocating an operation ID does **not** change `localJournalCounter`, `causalSummary`, semantic event authority, or happened-before. This separation is required so operation grouping cannot affect synchronization outcomes.

This allocation rule gives two distinct relations for semantic events.

### Total authority order

```text
authorityCompare(A,B):
    compare A.sequence and B.sequence numerically;
    on equality compare A.author lexicographically
```

This is a total order used only for deterministic conflict selection.

### Happened-before

For distinct event references `E` and `F`:

```text
happenedBefore(E,F) iff
    E.id.author == F.id.author
        ? E.id.sequence < F.id.sequence
        : E.id.sequence <= F.context[E.id.author]
```

A larger sequence on another author does not by itself prove happened-before.

Because a newly authored semantic event allocates above every observed coordinate, `happenedBefore(E,F)` implies `authorityCompare(E.id,F.id) < 0` for supported events.

## Event references

```text
EventRef = {
    id: JournalEventId,
    context: CausalPrefix
}
```

The context is immutable semantic metadata of the original event. Copying a reference through synchronization never changes it.

## Value identity

```text
ValueRef = EventRef
ValueId  = JournalEventId
```

A locally authored semantic value occurrence uses the ID of its `value` event as its `ValueId`.

The value payload is not part of `ValueRef` and is never journaled.

For supported state, one `ValueId` denotes one exact semantic value occurrence. Every replica currently materializing that `ValueId` must therefore hold the value/timestamp record copied from that occurrence or a reset/migration record which locally created that same ID. Ordinary synchronization need not compare payloads to verify this invariant.

## Certificate basis

The graph schema determines one ordered list of distinct direct semantic input edges for every concrete node:

```text
inputEdges(K) = [D0, D1, ...]
```

The maximum list length is assumed bounded for the storage bound.

A certificate basis has one entry per `inputEdges(K)`:

```text
BasisEntry = ValueId | "unknown"
```

`"unknown"` is a bounded sentinel used by bootstrap when the legacy graph proves that an incoming validity edge is absent but the historical value occurrence against which it was last valid is unavailable.

```text
ValidationCertificate = {
    event: EventRef,
    value: ValueId,
    basis: Array<BasisEntry>
}
```

The certificate's own causal context is the clearing evidence for invalidations it genuinely observed. Separate `clearsThrough` metadata is unnecessary in Journal 2.

For a fixed current value, only the greatest certificate by `authorityCompare(certificate.event.id, ...)` is semantically active. Lower certificates remain historical until compaction but are not consulted by projection or synchronization.

## Invalidation scopes

```text
InvalidateScope =
    | { kind: "node" }
    | { kind: "value", value: ValueId }

InvalidateMode = "soft" | "hard"
```

- node-scoped invalidation is always hard and represents explicit invalidation independent of the selected current value;
- value-scoped soft invalidation marks one cached value stale while preserving its incoming proof where still compatible;
- value-scoped hard invalidation also breaks that value's incoming proof.

Compacted summaries store invalidation frontiers instead of individual old invalidates:

```text
nodeInvalidateFrontier      : CausalPrefix
valueInvalidateFrontier     : CausalPrefix
valueHardInvalidateFrontier : CausalPrefix
```

The value-specific frontiers exist only for the currently selected present `ValueId`. They are discarded when that value can no longer become current.

## Semantic state head

```text
PresentHead = {
    kind: "present",
    value: ValueRef
}

AbsentHead = {
    kind: "absent",
    tombstone: EventRef
}

SemanticHead = PresentHead | AbsentHead
```

The head authority is `value.id` for present state and `tombstone.id` for absent state.

When two heads compete, the one with greater authority wins. A normal synchronization adoption preserves the winning foreign head exactly; the local adoption event does not become the new head.

## Per-node compacted summary

```text
NodeJournalSummary = {
    node: NodeKey,
    head: SemanticHead,

    nodeInvalidateFrontier: CausalPrefix,

    // Present only when head.kind == "present".
    certificate?: ValidationCertificate,
    valueInvalidateFrontier?: CausalPrefix,
    valueHardInvalidateFrontier?: CausalPrefix,

    // Local change-index coordinate, never imported as semantic authority.
    lastLocalChange: JournalSequence
}
```

The `certificate`, when present, must name the current `head.value.id`.

The three invalidation vectors and the contexts inside the current value/certificate dominate the summary size. Under bounded NodeKey and in-degree assumptions, one summary is `O(R log H)` bits.

## High-level operation records

Journal 2 preserves a lightweight distinction between a high-level local operation and the low-level semantic events produced by that operation.

```text
OperationKind =
    | "pull"
    | "invalidate"
    | "synchronize"
    | "reset"
    | "migration"
    | "bootstrap"
    | "other"

OperationRecord = {
    id: OperationId,
    kind: OperationKind,
    subject?: NodeKey
}
```

An operation record is local historical/debugging structure. It is **not** synchronization authority, has no `CausalPrefix`, and is never imported as semantic state.

A high-level operation may compile into arbitrarily many low-level semantic events. The operation record MUST NOT contain an array of all compiled events because that could make one LevelDB value proportional to graph size. Instead each low-level event produced directly by the operation carries the same optional `operation: OperationId` reference. The conceptual expansion is recovered from the event list by grouping those small records.

Nested operations may have distinct operation IDs. The specification does not require one parent operation record to enumerate all recursively nested operation IDs.

Compaction may discard old operation records and their corresponding raw-event grouping information together once the raw historical events they describe are compacted away. Operation grouping has no role in the compacted synchronization meaning.

## Historical semantic events

All raw low-level semantic events have this base:

```text
JournalEventBase = {
    id: JournalEventId,
    context: CausalPrefix,
    node: NodeKey,
    operation?: OperationId
}
```

Kinds:

```text
ValueEvent = JournalEventBase & {
    kind: "value",
    reason: "compute" | "bootstrap" | "reset"
}

DeleteEvent = JournalEventBase & {
    kind: "delete",
    reason: "sync-discard" | "reset" | "migration"
}

ValidateEvent = JournalEventBase & {
    kind: "validate",
    value: ValueId,
    basis: Array<BasisEntry>,
    reason: "compute" | "unchanged" | "cache-revalidate" | "bootstrap" | "reset"
}

InvalidateEvent = JournalEventBase & {
    kind: "invalidate",
    scope: InvalidateScope,
    mode: InvalidateMode,
    reason: "explicit" | "propagated" | "sync"
}

AdoptEvent = JournalEventBase & {
    kind: "adopt",
    source: JournalAuthor,
    // Bounded semantic metadata sufficient to fold the adopted node summary.
    adopted: NodeJournalSemanticPart
}
```

`NodeJournalSemanticPart` is `NodeJournalSummary` without `node` and `lastLocalChange`.

An `AdoptEvent` is local history but creates no new foreign value, certificate, invalidation, or tombstone authority. It records that those authorities became represented by this database.

The optional `operation` field has no effect on folding, authority, projection, synchronization, compaction correctness, or causality.

## Header and change index

```text
JournalHeader = {
    writer: JournalAuthor,
    incarnation: JournalIncarnation,
    localJournalCounter: JournalSequence | 0,
    localOperationCounter: LocalOperationSequence | 0,
    causalSummary: CausalPrefix
}
```

The compacted change index has exactly one live marker per represented node:

```text
ChangedNodeMarker = {
    node: NodeKey,
    sequence: JournalSequence
}
```

The marker sequence equals `NodeJournalSummary.lastLocalChange`. When the node summary changes locally, the old marker is removed and a new marker at the new local semantic-event sequence is inserted atomically.

## Cursor

```text
JournalCursor = {
    source: JournalAuthor,
    incarnation: JournalIncarnation,
    through: JournalSequence | 0
}
```

A cursor is valid only for the same **source** writer and source incarnation. Canonical compaction does not invalidate a cursor.

If that source performs controlled reset, its changed source incarnation invalidates cursors about it by field comparison.

If the receiver performs controlled reset, its stored cursors about other sources are not invalidated by their fields; the reset protocol explicitly deletes those receiver-local cursor records because the receiver no longer satisfies their incorporated-state invariant.

## Storage-domain restrictions

Journal records contain only bounded primitive tags, NodeKeys, IDs/counters, causal vectors, bounded input-version arrays, and small operation-grouping records/references. They contain no `ComputedValue`, no copy of `values[id]`, and no graph-wide collection proportional to `N` or event history in one LevelDB value.