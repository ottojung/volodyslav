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

There is exactly one event-ID format and there are no sync-event IDs:

```text
eventId = JSON.stringify([
    "host-event-v1",
    hostname,
    hostInstanceId,
    originIndex,
])
```

The LWW comparison of two `eventId` strings is lexicographic comparison of
their UTF-8 bytes.

#### originIndex is the original LocalJournalIndex

For every host-originated logical event:

```text
originIndex equals the LocalJournalIndex assigned to its original occurrence.
```

During darkroom finalization:

1. allocate a fresh local physical index;
2. use that same number as `origin.originIndex`;
3. derive `eventId`;
4. write the logical event at that original occurrence;
5. advance the local physical watermark in the same batch.

There is no separate `lastOriginIndex`. An imported event or a notification
carrier preserves its `origin` and `eventId` from the originating event and
receives a newly allocated local physical `JournalIndex` on the receiving
replica. No sequence may ever reuse one `(hostname, HostInstanceId,
originIndex)` tuple: origin indices never decrease, physical indices never
decrease, and each tuple is allocated exactly once.

A local physical `JournalIndex` is not part of logical event identity, logical
event order, snapshot equality, synchronization conflict resolution, or
canonical journal normalization.

#### Local physical watermark

The local physical watermark is persisted durably and:

- initialized to zero only for genuinely new storage;
- advanced atomically with the occurrences of the same batch;
- never decreased by compaction;
- never derived from surviving entries after compaction;
- preserved across reset;
- copied correctly into migration and synchronization destinations;
- loaded on restart before any allocation.

#### HostInstanceId lifecycle

`HostInstanceId` is generated exactly once for genuinely new local storage and
persisted as local allocator metadata. It is:

- stable across restart, reset, migration, compaction, and replica cutover;
- copied into every inactive destination that may become the same local
  storage;
- changed only for genuinely unrelated reinitialization.

This metadata is local event-allocation infrastructure. It is not merge
authority and not part of journal conflict resolution.

#### Origin-allocation tests

The following sequences each produce fresh tuples and advance the physical
watermark; no sequence reuses a `(hostname, HostInstanceId, originIndex)`
tuple:

- event creation after logical compaction (the new event's `originIndex` is
  the new local physical index, above the watermark);
- event creation after physical compaction (same rule; the watermark is never
  recomputed from surviving entries);
- restart (the watermark is loaded before any allocation);
- reset (the watermark is preserved);
- migration cutover (the watermark is copied into the destination);
- synchronization cutover (the watermark is copied into the destination);
- imported occurrences advancing the physical watermark (each import receives
  a new local physical index while preserving `origin`/`eventId`);
- notification carriers advancing the physical watermark (each carrier
  receives a new local physical index for the same `eventId`).



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
tone:
    "up-to-date"
    | "potentially-outdated"
validInputStateEvents:
    Map<input NodeKey, eventId>
```

It applies only when that exact state event remains selected. Freshness entries
for one subject are ordered by:

```text
freshnessOrder(entry) = (
    logicalRevision,
    eventId,
)
```

Every freshness transition is represented as a journal entry, including
staleness that arises by recursive propagation. The runtime graph cache and the
journal projection therefore always agree.

#### Validate

```text
{
    action: "validate",
    subjectStateEventId,
    tone: "up-to-date",
    validInputStateEvents:
        Map<input NodeKey, eventId>,
}
```

It records the exact selected input state events against which the unchanged
cached value was validated. A dependent becomes fresh only after its own
`validate` event.

#### Invalidate

```text
{
    action: "invalidate",
    subjectStateEventId,
    tone: "potentially-outdated",
    validInputStateEvents: Map<input NodeKey, eventId>,
}
```

Two forms exist, distinguished by the proof map:

- **Explicit invalidation** of the named node emits `invalidate` with an
  empty proof map: the node's incoming validity proofs are removed.
- **Recursively propagated invalidation** emits `invalidate` while preserving
  the existing proof map: the node's incoming validity proofs remain, exactly
  as the flag-based inverse-validity algorithm requires.

A stale node may therefore carry a complete proof map; it becomes fresh only
when a later `validate` entry for the same subject state event arrives.
Exactly one no-op rule exists: a repeated **explicit invalidation** of an
already explicitly invalidated state — a state whose selected stale assertion
already has an empty proof map — is a no-op. An explicit invalidation of a
propagated-stale node (whose selected stale assertion still has a nonempty
proof map) is NOT a no-op: it removes the incoming proofs so the next pull must
invoke the computor. A propagated invalidation of a node whose selected
assertion is already stale is a no-op, and propagation never replaces an
already-selected empty proof map with a preserved proof map.

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

## 6. Canonical serialization

`eventId` is the final state/freshness conflict tie-breaker and `LogicalSnapshotId`
is a digest of the canonical encoding, so the encoding is normative and
executable. "Canonical encoding" always means this single fully specified byte
format; there is no other encoding. Two implementations that encode the same
logical journal must produce byte-identical serializations.

### 6.1 Primitives

One byte order is used everywhere, big-endian:

```text
u32(n) = four-byte unsigned big-endian integer
u64(n) = eight-byte unsigned big-endian integer
```

```text
bytes(s)  = UTF-8 bytes of s
string(s) = u64(byteLength(bytes(s))) || bytes(s)

array(xs) =
    u64(xs.length) || encode(xs[0]) || ... || encode(xs[n-1])

map(entries) =
    u64(entries.length) ||
    encoded key/value pairs sorted by canonical encoded key bytes
```

Every variable-length item is self-delimiting through its length prefix. Tags
are fixed single bytes.

### 6.2 Numeric domains

All numeric values are IEEE-754 binary64. `originIndex`, `logicalRevision`, and
`time` (Unix milliseconds) are `u64` integers within `[0, 2^53-1]`. No other
integer domain is valid.

For journal-stored `SimpleValue` numbers:

- byte order is big-endian binary64;
- `-0` is encoded as `+0` (identical bytes);
- NaN is not a valid journal `SimpleValue` number; the number encoder still
  normalizes every NaN bit pattern to the single canonical NaN
  `0x7FF8000000000000` before encoding, so no two NaN payloads can ever
  produce different bytes;
- positive and negative infinity are not valid journal `SimpleValue` numbers;
- any number outside a stated domain is rejected by validation.

### 6.3 SimpleValue encoding

The main graph specification defines:

```text
SimpleValue =
    number
    | string
    | boolean
    | Array<SimpleValue>
    | Record<string, SimpleValue>
```

`null` is NOT a SimpleValue and has no accepted encoding. A record encodes as a
sorted map of string -> value, sorted by the UTF-8 bytes of the key.

```text
string      0x01 string(s)
number      0x02 u64(bits)          // big-endian binary64
boolean     0x03 0x00 | 0x01
array       0x04 array(elements)    // elements preserve order
record      0x05 map(string -> value)
```

### 6.4 Entry encoding

Every journal entry encodes as a fixed single-byte variant tag followed by the
self-delimiting fields. The derived `eventId` is NOT included in the entry
bytes: it is deterministically derived from `origin` (§ 2.1), and is compared
and hashed through its derived value during ordering and integrity checks.

```text
origin = array([string(hostname), string(hostInstanceId), u64(originIndex)])
proof  = map(string(inputKey) -> string(eventId))

0x11 add:
    0x11 || origin || string(key) || u64(time) || u64(logicalRevision)
        || string(id) || SimpleValue(value)
        || u64(createdAtMs) || u64(modifiedAtMs)
        || u8(storedFreshness) || proof

0x12 edit:
    same layout as 0x11

0x13 delete:
    0x13 || origin || string(key) || u64(time) || u64(logicalRevision)
        || string(id)

0x14 validate:
    0x14 || origin || string(key) || u64(time) || u64(logicalRevision)
        || string(subjectStateEventId) || u8(tone) || proof

0x15 invalidate:
    same layout as 0x14
```

`u8(storedFreshness)` and `u8(tone)` encode `0x01` for `"up-to-date"` and
`0x02` for `"potentially-outdated"`. The variant tag determines `action`
(0x11=add, 0x12=edit, 0x13=delete, 0x14=validate, 0x15=invalidate); the
action/tone pairing (`validate` with up-to-date, `invalidate` with
potentially-outdated) is validated by `validateLogicalSnapshot`.

### 6.5 eventId

`eventId` is a runtime string:

```text
eventId = JSON.stringify([
    "host-event-v1",
    hostname,
    hostInstanceId,
    originIndex,
])
```

LWW comparison in `stateOrder` and `freshnessOrder` is lexicographic comparison
of the UTF-8 bytes of this string. `string(eventId)` is used only when the
`eventId` is embedded inside another byte encoding (proof maps, snapshot entry
ordering, `subjectStateEventId`).

### 6.6 Immutable payload equality

Two logical events are payload-equal exactly when their full canonical
serialization bytes are equal (variant tag plus all fields). The integrity check
of INV-JT-02 compares these bytes.

### 6.7 Snapshot byte sequence

```text
snapshotBytes =
    array([
        string("logical-snapshot"),
        u64(1),                        // canonical-encoding version
        string(schemaVersion),
        string(mergeProtocolVersion),
        array([
            normalized entry encodings,
            sorted by derived eventId UTF-8 bytes,
        ]),
    ])

LogicalSnapshotId = sha256(snapshotBytes)
```

### 6.8 Fixed test vectors

Origin and events under schema `"schema-1"`, protocol `"proto-1"`:

```text
A = add, origin ("h1", "i1", 5), key "k", time 1000, revision 1,
    id "n1", value 1, createdAt 1000, modifiedAt 1000,
    storedFreshness up-to-date, proof {}
eventId A = ["host-event-v1","h1","i1",5]

B = invalidate, origin ("h1", "i1", 6), key "k", time 1100, revision 1,
    subject = eventId A, tone potentially-outdated, proof {}
eventId B = ["host-event-v1","h1","i1",6]

C = edit, origin ("h1", "i1", 7), key "k", time 2000, revision 2,
    id "n1", value 2, createdAt 1000, modifiedAt 2000,
    storedFreshness potentially-outdated, proof { "a" -> eventId A }
eventId C = ["host-event-v1","h1","i1",7]
```

Entry bytes (hexadecimal):

```text
A = 11000000000000000300000000000000026831000000000000000269310000
    00000000000500000000000000016b00000000000003e80000000000000001
    00000000000000026e31023ff000000000000000000000000003e800000000
    000003e8010000000000000000

B = 15000000000000000300000000000000026831000000000000000269310000
    00000000000600000000000000016b000000000000044c0000000000000001
    000000000000001d5b22686f73742d6576656e742d7631222c226831222c22
    6931222c355d020000000000000000

C = 11000000000000000300000000000000026831000000000000000269310000
    00000000000700000000000000016b00000000000007d00000000000000002
    00000000000000026e31024000000000000000000000000000003e80000000
    000007d0020000000000000001000000000000000161000000000000001d5b
    22686f73742d6576656e742d7631222c226831222c226931222c355d
```

Normalized ordering by derived eventId is `A, B, C`.

Snapshot bytes (hexadecimal) and the derived identity:

```text
snapshot bytes = 000000000000000500000000000000106c6f676963616c2d736e
    617073686f7400000000000000010000000000000008736368656d612d310000
    00000000000770726f746f2d3100000000000000031100000000000000030000
    0000000000026831000000000000000269310000000000000005000000000000
    00016b00000000000003e8000000000000000100000000000000026e31023ff0
    000000000000000000000000003e800000000000003e801000000000000000015
    0000000000000003000000000000000268310000000000000002693100000000
    0000000600000000000000016b000000000000044c0000000000000001000000
    000000001d5b22686f73742d6576656e742d7631222c226831222c226931222c
    355d020000000000000000110000000000000003000000000000000268310000
    0000000000026931000000000000000700000000000000016b00000000000007
    d0000000000000000200000000000000026e3102400000000000000000000000
    0000003e800000000000007d002000000000000000100000000000000016100
    0000000000001d5b22686f73742d6576656e742d7631222c226831222c226931
    222c355d

LogicalSnapshotId = sha256(snapshot bytes)
                  = f7895e75aae5e3cf7d1a328908ef2d82dfb24ec5ba30fa8ad4b8
                    dab5c1b16fd0
```

### 6.9 Ambiguity tests

The encoding is injective and order-independent where required:

- `["ab", "c"]` and `["a", "bc"]` produce different bytes (the string length
  prefix disambiguates nesting at the array level);
- `["a", ["b", "c"]]` and `[["a", "b"], "c"]` produce different bytes;
- record insertion order does not affect bytes (record keys are sorted);
- map insertion order does not affect bytes (map keys are sorted);
- `-0` and `+0` produce identical bytes;
- every NaN bit pattern normalizes to canonical NaN and produces identical
  bytes (and journal validation rejects NaN in authoritative values).

Normalized entries are sorted by `eventId` before hashing.

---

## 7. Local physical position

A separate local physical `JournalIndex` identifies one physical occurrence in
one replica's journal storage. It is:

- allocated monotonically and locally during serialized finalization;
- never part of `eventId`, logical order, snapshot equality, or normalization;
- used only by the public cursor API and by physical compaction.

Imported events and notification carriers are appended at fresh local physical
indices, strictly after the local watermark. Physical placement is host-local
and is not required to converge across hosts.

---

## 8. Public tokens

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

## 9. Snapshot identity and transport

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
    sha256(snapshotBytes)   // the exact byte sequence of § 6.7
```

Logical identity excludes graph-basis, journal-basis, causal-frontier,
provenance, watermark, physical-index, gap, and carrier-position fields.
Physical snapshot encoding may include the materialized graph cache and local
journal layout, but those are transport/storage details.

**PROP-JT-02 (Snapshot identity reflects logical state).** Equal normalized
logical journals produce equal `LogicalSnapshotId`s; a change in any retained
logical event, in schema version, or in merge-protocol version changes the
identity.

### 9.1 Snapshot validation

`validateLogicalSnapshot(snapshot)` runs before any union. It requires:

- exactly one known entry variant, with exactly the required fields and no
  ambiguous alternate layouts;
- a valid `origin` and `eventId` (the `eventId` must equal the deterministic
  derivation from `origin`);
- valid `logicalRevision` and `time` domains;
- valid `NodeKey` and `NodeIdentifier` forms;
- canonical proof maps with no duplicate keys;
- a freshness entry whose `subjectStateEventId` belongs to the same semantic
  key as the entry;
- a valid action/tone/payload combination (for example, `validate` always
  pairs with `tone = "up-to-date"`, `invalidate` with
  `"potentially-outdated"`);
- full payload bytes agreeing for repeated `eventId`s (INV-JT-02).

Dangling input proof `eventId`s are allowed: they represent proofs against
losing historical input states. A proof target is not required to survive
normalization.

---

## 10. Global invariants

```text
The canonical journal is the only synchronization authority.
join(A, B) = normalize(events(A) ∪ events(B)).
The graph is a deterministic projection of schema plus canonical journal entries.
No synchronization operation creates a new logical journal event.
A complete materialization lives in its state entry, so closure-suppressed
values require no hidden merge basis.
Freshness events are scoped to an exact state event, so validation of an old
state cannot overwrite a newer value.
Every freshness transition is a journal entry, so the committed runtime graph
cache always equals projectGraph(schema, canonical journal).
Logical state is commutative, associative, and idempotent.
Physical cursor positions are local notification infrastructure.
Compaction is canonical maximum selection, not evidence pruning.
Every committed graph cache equals projectGraph(schema, canonical journal).
Darkroom finalization derives entries from the current committed assertion,
not from a stale prepared assertion.
A propagated invalidation can never restore proofs removed by an explicit
invalidation.
Holiday freezes graph writers; closeGarden protects physical replica readers.
A host event's originIndex is its original LocalJournalIndex.
No event-origin coordinate is ever reused.
Every published projected graph satisfies the complete IncrementalGraph storage
and validity invariants.
Canonical serialization determines one exact byte sequence.
```
