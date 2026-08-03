# Incremental Graph Journal — Types, Identity, and Normalization

This document defines the journal's logical event model: event identity, logical
revisions, canonical normalization, the logical-vs-physical occurrence
distinction, public tokens, and snapshot identity. It is the single source of
truth for the logical journal.

---

## 1. Settled architectural principle

**INV-JT-00 (Journal-only authority):** The canonical set of immutable journal
entries is the only authoritative synchronization state:

```text
canonical journal entries
    -> deterministic graph projection
    -> persisted runtime graph cache
```

The persisted IncrementalGraph database may retain values, freshness,
timestamps, identifiers, and validity relations for efficient runtime access,
but these are a rebuildable materialized cache. They are not an independent
merge authority. No other synchronization-critical state exists. A snapshot may
carry a derived digest for integrity or caching, but the digest is computed from
the canonical journal entries and is not additional merge state.

---

## 2. Logical events and physical occurrences

```text
logical event
    = one immutable JournalEntry identified by eventId

physical occurrence
    = one local journal position containing that event
```

One logical event may have several physical occurrences on one replica because
synchronization may append a notification carrier.

- Logical synchronization operates on logical events.
- The public cursor API operates on local physical occurrences.
- These two notions are never confused.

**INV-JT-01 (Logical identity):** `eventId` identifies a logical event's
immutable payload. A copied or repositioned event preserves its `eventId` and
complete payload.

**INV-JT-02 (Payload integrity):** If the same `eventId` occurs with two
different immutable payloads, synchronization rejects the exchange atomically.

### 2.1 Event origin identity

```text
origin = {
    hostname,
    hostInstanceId,
    originIndex,
}
```

`originIndex` is allocated monotonically by the originating storage instance.
There is exactly one event-ID format and there are no sync-event IDs:

```text
eventId = canonical encoding of [
    "host-event-v1",
    hostname,
    hostInstanceId,
    originIndex,
]
```

A local physical `JournalIndex` is separate and is not part of logical event
identity, logical event order, snapshot equality, synchronization conflict
resolution, or canonical journal normalization. Imported events and notification
carriers are appended at fresh local physical indices.

---

## 3. JournalEntry design

The journal has two independent logical categories per semantic key:

```text
state:
    add | edit | delete

freshness/proof:
    invalidate | validate
```

The two categories are never collapsed into one full-node LWW register: a
concurrent validation of an old state must never overwrite a concurrent edit
that created a new state.

### 3.1 Common fields

Every logical event contains:

```text
eventId
origin
key
time
action
logicalRevision
```

- `time` is wall-clock provenance for the public API. It is never used for
  conflict resolution.
- `creator` is derivable from `origin.hostname` and need not be stored
  separately.

### 3.2 State entries

```text
StateJournalEntry =
    AddJournalEntry
    | EditJournalEntry
    | DeleteJournalEntry
```

State entries are ordered per key by:

```text
stateOrder(entry) = (
    logicalRevision,
    eventId,
)
```

The greater tuple wins.

#### Add and edit payload

An `add` or `edit` entry carries a complete recoverable materialization
assertion:

```text
{
    action: "add" | "edit",

    id: NodeIdentifier,
    key: NodeKey,

    value: ComputedValue,

    createdAt: UnixTimestamp,
    modifiedAt: UnixTimestamp,

    storedFreshness:
        "up-to-date"
        | "potentially-outdated",

    validInputStateEvents:
        Map<input NodeKey, eventId>,
}
```

`validInputStateEvents` represents the node's incoming validity proofs at the
time of the assertion. For every included input:

```text
input key -> exact selected state event ID
```

It is not a general causal context. It records only the exact graph facts
required to rebuild the validity relation. It may be complete even when the
node is stale, because recursively propagated staleness preserves incoming
validity proofs under the flag-based validity algorithm. An explicit
invalidation, by contrast, clears incoming validity.

#### Delete payload

```text
{
    action: "delete",
    id,
    key,
}
```

A delete contains no value or proof payload. A later state assertion with a
greater state revision can re-materialize the key.

### 3.3 Freshness entries

```text
FreshnessJournalEntry =
    InvalidateJournalEntry
    | ValidateJournalEntry
```

Every freshness entry contains:

```text
subjectStateEventId
```

It applies only when that exact state event remains selected. Freshness entries
for one subject are ordered by:

```text
freshnessOrder(entry) = (
    logicalRevision,
    eventId,
)
```

#### Validate

```text
{
    action: "validate",
    subjectStateEventId,
    validInputStateEvents:
        Map<input NodeKey, eventId>,
}
```

It records the exact selected input state events against which the unchanged
cached value was validated.

#### Invalidate

```text
{
    action: "invalidate",
    subjectStateEventId,
    validInputStateEvents: empty,
}
```

It represents removal of the named node's incoming validity proofs. Freshness
events are never emitted merely because a node became stale through upstream
propagation; that staleness is derived during graph projection, and its existing
incoming proofs remain available.

---

## 4. Logical revision allocation

No operation ID, transaction ID, host-state version, vector clock, or causal
context exists. A Lamport-style `logicalRevision` is scoped to one semantic key
and category.

### State event creation

For a new state entry of key `K`:

```text
logicalRevision =
    1 + revision of the currently selected state entry for K
```

Use `1` when no state entry exists.

### Freshness event creation

For a new freshness entry for selected state event `S`:

```text
logicalRevision =
    1 + revision of the currently selected freshness entry for S
```

Use `1` when no explicit freshness entry exists for `S`.

### Last-writer-wins tradeoff

Concurrent hosts may produce equal revisions; `eventId` is the deterministic
final tie-breaker. This deliberately implements deterministic LWW semantics:

- an event created after observing a winner receives a greater revision;
- concurrent events are ordered deterministically;
- the protocol does not try to distinguish every concurrent relationship;
- there is no special concurrent-delete-wins policy.

This is an explicit, documented design choice: simplicity and determinism over
conservative concurrency detection. A concurrent validate of an old state cannot
overwrite a newer state, because state selection never consults freshness
entries and is decided only among state entries.

---

## 5. Canonical journal normalization

Define exactly one function:

```text
normalizeJournal(entries)
```

Algorithm:

1. Deduplicate logical events by `eventId`.
2. Reject different immutable payloads under the same `eventId`.
3. For each semantic key, select the maximum state entry by `stateOrder`.
4. If the selected state exists, select the maximum freshness entry:
   - whose `subjectStateEventId` equals the selected state event ID;
   - ordered by `freshnessOrder`.
5. Discard every other logical event.

The normalized logical journal contains at most:

```text
one state entry per key
one applicable freshness entry per key
```

**PROP-JT-01 (Normalization is a monotone maximum selection).** For any sets of
entries `A` and `B`:

```text
normalize(normalize(A) ∪ B)
    = normalize(A ∪ B)
```

The reasons are:

- a non-maximal state entry can never become maximal after adding more entries,
  because `stateOrder` is a total order and adding entries cannot increase an
  existing entry's position;
- a freshness entry for a non-selected state can never become applicable later,
  because state selection never moves backwards once it is fixed by the maximum;
- a non-maximal freshness entry for the selected state can never become maximal
  after adding more entries, for the same total-order reason.

---

## 6. Local physical position

A separate local physical `JournalIndex` identifies one physical occurrence in
one replica's journal storage. It is:

- allocated monotonically and locally during serialized finalization;
- never part of `eventId`, logical order, snapshot equality, or normalization;
- used only by the public cursor API and by physical compaction.

Imported events and notification carriers are appended at fresh local physical
indices, strictly after the local watermark. Physical placement is host-local
and is not required to converge across hosts.

---

## 7. Public tokens

The public API surface is:

```text
graph.possibleMaybeChanges({ since, to })
baselinePossibleNodeChange()
PossibleNodeChange fields:
    nodeName
    bindings
    action
    time
```

A `PossibleNodeChange` is a conservative possible-change notification. It does
not assert current graph state; a returned action may describe a transition
relative to an older state. Carrier copies are therefore legitimate.

Private same-process cursor tokens remain supported. A cursor returned during a
process session is valid as `since` for subsequent calls within that same
process session. Persistence of cursor tokens across process restarts,
synchronization boundaries involving heterogeneous hosts, or migration/schema
boundaries, and the corresponding long-lived validity guarantees, are outside
this journal's token contract.

---

## 8. Snapshot identity and transport

A logical transport snapshot contains:

```text
schemaVersion
mergeProtocolVersion
normalizeJournal(entries)
```

The graph projection may be included as a cache, but it must equal
`projectGraph(schema, normalizedJournal)` and does not participate as an
independent authority.

```text
LogicalSnapshotId =
    sha256(canonical encoding of [
        schemaVersion,
        mergeProtocolVersion,
        normalized journal entries,
    ])
```

Logical identity excludes graph-basis, journal-basis, causal-frontier,
provenance, watermark, physical-index, gap, and carrier-position fields.
Physical snapshot encoding may include the materialized graph cache and local
journal layout, but those are transport/storage details.

**PROP-JT-02 (Snapshot identity reflects logical state).** Equal normalized
logical journals produce equal `LogicalSnapshotId`s; a change in any retained
logical event, in schema version, or in merge-protocol version changes the
identity.

---

## 9. Global invariants

```text
The canonical journal is the only synchronization authority.
join(A, B) = normalize(events(A) ∪ events(B)).
The graph is a deterministic projection of schema plus canonical journal entries.
No synchronization operation creates a new logical journal event.
A complete materialization lives in its state entry, so closure-suppressed
values require no hidden merge basis.
Freshness events are scoped to an exact state event, so validation of an old
state cannot overwrite a newer value.
Logical state is commutative, associative, and idempotent.
Physical cursor positions are local notification infrastructure.
Compaction is canonical maximum selection, not evidence pruning.
```
