# IncrementalGraph Journal 2 Types

## Primitive identities

```text
JournalAuthor      = DatabaseFingerprint
JournalSequence    = positive arbitrary-precision integer
JournalIncarnation = positive arbitrary-precision integer
JournalEventId     = { author: JournalAuthor, sequence: JournalSequence }
CausalPrefix       = Map<JournalAuthor, JournalSequence>
```

Missing coordinates in a `CausalPrefix` mean zero.

A journal cursor is meaningful only inside one `(sourceFingerprint, incarnation)` pair.

## Lamport-compatible allocation

Every writable database persists:

```text
localJournalCounter : JournalSequence | 0
causalSummary       : CausalPrefix
journalIncarnation  : JournalIncarnation
```

Before authoring a local journal event, allocate:

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

Multiple events in one atomic transaction receive increasing local sequences in a deterministic order and each later event observes the earlier event.

This allocation rule gives two distinct relations.

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

Because a newly authored event allocates above every observed coordinate, `happenedBefore(E,F)` implies `authorityCompare(E.id,F.id) < 0` for supported events.

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

## Historical events

All raw historical events have this base:

```text
JournalEventBase = {
    id: JournalEventId,
    context: CausalPrefix,
    node: NodeKey
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

## Header and change index

```text
JournalHeader = {
    writer: JournalAuthor,
    incarnation: JournalIncarnation,
    localJournalCounter: JournalSequence | 0,
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

The marker sequence equals `NodeJournalSummary.lastLocalChange`. When the node summary changes locally, the old marker is removed and a new marker at the new local event sequence is inserted atomically.

## Cursor

```text
JournalCursor = {
    source: JournalAuthor,
    incarnation: JournalIncarnation,
    through: JournalSequence | 0
}
```

A cursor is valid only for the same source writer and incarnation. Canonical compaction does not invalidate a cursor. Controlled reset changes the incarnation and therefore invalidates every old cursor by construction.

## Storage-domain restrictions

Journal records contain only bounded primitive tags, NodeKeys, IDs/counters, causal vectors, and bounded input-version arrays. They contain no `ComputedValue`, no copy of `values[id]`, and no graph-wide collection proportional to `N` or event history in one LevelDB value.