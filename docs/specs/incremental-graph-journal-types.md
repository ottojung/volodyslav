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

#### Root-local physical/event allocator

`HostInstanceId` and `lastLocalJournalIndex` are **root-local durable allocator
metadata**, shared by both replica slots of one `RootDatabase` — not
per-replica fields. They are local physical/event-allocation infrastructure,
not synchronization authority and not part of logical snapshot identity.

```text
allocateLocalJournalIndex():
    atomically advance the root-local watermark
    return the new value
```

Every physical occurrence consumes an index from this single allocator:

- a host-originated logical event (its `originIndex` is the allocated
  `LocalJournalIndex`);
- an imported event occurrence;
- a notification carrier;
- an inactive migration occurrence;
- a synchronization destination occurrence where a new local position is
  required.

For a host-originated event:

```text
originIndex = allocated LocalJournalIndex
eventId = derived from hostname, HostInstanceId, originIndex
```

For imported events and carriers:

```text
origin / eventId = preserved from the originating event
LocalJournalIndex = newly allocated locally
```

There is no separate `lastOriginIndex`.

`HostInstanceId` is generated exactly once for genuinely new local storage and
persisted with the root-local allocator. It is stable across restart, reset,
migration, compaction, and replica cutover; it is changed only for genuinely
unrelated reinitialization. A failed inactive migration may advance the
root-local allocator and leave gaps, but it must never permit reuse.

#### Failure guarantee for inactive work

```text
failed migration or synchronization destination build:
    active graph, active logical journal, active physical occurrences: unchanged
    root-local allocation watermark: may have advanced
```

The possible watermark advance is acceptable and required for uniqueness: no
retry may reuse a `(hostname, HostInstanceId, originIndex)` tuple.

A local physical `JournalIndex` is not part of logical event identity, logical
event order, snapshot equality, synchronization conflict resolution, or
canonical journal normalization.

#### Local physical watermark

The root-local physical watermark is persisted durably and:

- initialized to zero only for genuinely new storage;
- advanced atomically with the occurrences of the same batch;
- never decreased by compaction;
- never derived from surviving entries after compaction;
- preserved across reset;
- shared by both replica slots (a destination that may become active continues
  from the root-local allocator, never from a copied stale value);
- loaded on restart before any allocation.

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
- migration cutover (the destination continues from the root-local allocator);
- synchronization cutover (the destination continues from the root-local
  allocator);
- imported occurrences advancing the physical watermark (each import receives
  a new local physical index while preserving `origin`/`eventId`);
- notification carriers advancing the physical watermark (each carrier
  receives a new local physical index for the same `eventId`).

#### Root-local allocator traces

Each trace proves that no `(hostname, HostInstanceId, originIndex)` tuple is
ever reused:

- **Failed inactive migration followed by retry:** the first attempt advances
  the root-local watermark to `W` then fails. The retry allocates indices
  strictly above `W`, so the failed attempt's indices are never reused.
- **Failed migration followed by ordinary host event:** the host event
  allocates an index strictly above the failed migration's last allocation.
- **Failed synchronization destination build followed by retry:** the retry
  allocates destination occurrences strictly above the failed build's last
  allocation.
- **Restart after failed inactive work:** the root-local watermark is loaded
  before any allocation, so the failed work's indices remain consumed.
- **Alternating active replica slots:** both slots allocate from the single
  root-local allocator, so no slot can produce an index the other slot already
  consumed.
- **Compaction after gaps:** compaction never recomputes or decreases the
  watermark; new allocations stay strictly above the highest ever allocated
  index, including indices freed as gaps.



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

map(entries):
    sort entries by the raw canonical key comparison defined for the map's key
        type
    encode u64(entries.length)
    encode each self-delimiting key/value pair
```

Every variable-length item is self-delimiting through its length prefix. Tags
are fixed single bytes.

There is exactly one ordering rule for every string-keyed canonical map
(`SimpleValue` record keys, proof-map input keys, and any future string-keyed
map):

```text
compare the raw UTF-8 key bytes lexicographically.
```

The encoded length prefix is framing only and does not participate in map-key
ordering. For keys `"z"`, `"aa"`, `"a"`, the canonical order is `"a"`, `"aa"`,
`"z"` (raw lexicographic: `"a" < "aa" < "z"`).

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

All vectors use schema `"schema-1"`, protocol `"proto-1"`, and the entry
layout of § 6.4 with big-endian `u64` framing, raw-UTF-8 map-key ordering, and
the variant tags `add=0x11`, `edit=0x12`, `delete=0x13`, `validate=0x14`,
`invalidate=0x15`. The bytes below were generated by the normative encoding
described in this section.

#### Vector 1 — Entry encoding

Five independent entries; every variant begins with its correct tag:

```text
add:
  origin ("h1","i1",5), key "k", time 1000, revision 1, id "n1",
  value 1, createdAt 1000, modifiedAt 1000, up-to-date, proof {}
  tag 0x11
  hex = 11000000000000000300000000000000026831000000000000000269310000
        00000000000500000000000000016b00000000000003e80000000000000001
        00000000000000026e31023ff000000000000000000000000003e800000000
        000003e8010000000000000000

edit:
  origin ("h1","i1",6), key "k", time 2000, revision 2, id "n1",
  value 2, createdAt 1000, modifiedAt 2000, potentially-outdated,
  proof { "a" -> eventId(add) }
  tag 0x12
  hex = 12000000000000000300000000000000026831000000000000000269310000
        00000000000600000000000000016b00000000000007d00000000000000002
        00000000000000026e31024000000000000000000000000000003e80000000
        000007d0020000000000000001000000000000000161000000000000001d5b
        22686f73742d6576656e742d7631222c226831222c226931222c355d

validate:
  origin ("h1","i1",7), key "k", time 1500, revision 1,
  subject = eventId(add), up-to-date,
  proof { "a" -> eventId(add) }
  tag 0x14
  hex = 14000000000000000300000000000000026831000000000000000269310000
        00000000000700000000000000016b00000000000005dc0000000000000001
        000000000000001d5b22686f73742d6576656e742d7631222c226831222c22
        6931222c355d01000000000000000100000000000000016100000000000000
        1d5b22686f73742d6576656e742d7631222c226831222c226931222c355d

invalidate:
  origin ("h1","i1",8), key "k", time 1100, revision 1,
  subject = eventId(add), potentially-outdated, proof {}
  tag 0x15
  hex = 15000000000000000300000000000000026831000000000000000269310000
        00000000000800000000000000016b000000000000044c0000000000000001
        000000000000001d5b22686f73742d6576656e742d7631222c226831222c22
        6931222c355d020000000000000000

delete:
  origin ("h1","i1",9), key "k", time 3000, revision 1, id "n1"
  tag 0x13
  hex = 13000000000000000300000000000000026831000000000000000269310000
        00000000000900000000000000016b0000000000000bb80000000000000001
        00000000000000026e31
```

#### Vector 2 — Normalization

Input:

```text
A = add, origin ("h1","i1",5), key "k", time 1000, revision 1, id "n1",
    value 1, createdAt 1000, modifiedAt 1000, up-to-date, proof {}
B = invalidate, origin ("h1","i1",6), subject = eventId(A), stale, proof {}
C = edit, origin ("h1","i1",7), key "k", time 2000, revision 2, id "n1",
    value 2, createdAt 1000, modifiedAt 2000, potentially-outdated,
    proof { "a" -> eventId(A) }
```

`normalizeJournal({A, B, C}) = [C]`: `C` defeats `A` by `stateOrder`
(`(2, eventId C) > (1, eventId A)`), and `B` is not applicable to `C` because
its `subjectStateEventId` is `eventId(A)`, not `eventId(C)`.

```text
C bytes hex = 120000000000000003000000000000000268310000000000000002693
    1000000000000000700000000000000016b00000000000007d00000000000000002
    00000000000000026e31024000000000000000000000000000003e800000000000
    007d0020000000000000001000000000000000161000000000000001d5b22686f
    73742d6576656e742d7631222c226831222c226931222c355d

snapshot bytes hex = 000000000000000500000000000000106c6f676963616c2d736e
    617073686f7400000000000000010000000000000008736368656d612d31000000
    000000000770726f746f2d31000000000000000112000000000000000300000000
    00000002683100000000000000026931000000000000000700000000000000016b
    00000000000007d0000000000000000200000000000000026e3102400000000000
    000000000000000003e800000000000007d0020000000000000001000000000000
    000161000000000000001d5b22686f73742d6576656e742d7631222c226831222c
    226931222c355d

LogicalSnapshotId = sha256(snapshot bytes)
                  = 03741fe065bffd0dbe715f6f7963b5257c86bb498e03b474dc0e
                    24a5e1220c60
```

#### Vector 3 — Applicable freshness

Input:

```text
A = add, origin ("h1","i1",5), key "k", time 1000, revision 1, id "n1",
    value 1, createdAt 1000, modifiedAt 1000, up-to-date, proof {}
B = invalidate, origin ("h1","i1",6), subject = eventId(A), stale, proof {}
```

`normalizeJournal({A, B}) = [A, B]` (A is the selected state; B is applicable
because its subject is `eventId(A)`). Entry ordering by derived eventId is `A,
B`.

```text
A bytes hex = 110000000000000003000000000000000268310000000000000002693
    1000000000000000500000000000000016b00000000000003e80000000000000001
    00000000000000026e31023ff000000000000000000000000003e80000000000000
    3e8010000000000000000

B bytes hex = 150000000000000003000000000000000268310000000000000002693
    1000000000000000600000000000000016b000000000000044c0000000000000001
    000000000000001d5b22686f73742d6576656e742d7631222c226831222c226931
    222c355d020000000000000000

snapshot bytes hex = 000000000000000500000000000000106c6f676963616c2d736e
    617073686f7400000000000000010000000000000008736368656d612d31000000
    000000000770726f746f2d31000000000000000211000000000000000300000000
    00000002683100000000000000026931000000000000000500000000000000016b
    00000000000003e8000000000000000100000000000000026e31023ff000000000
    000000000000000003e800000000000003e8010000000000000000150000000000
    000003000000000000000268310000000000000002693100000000000000060000
    0000000000016b000000000000044c0000000000000001000000000000001d5b22
    686f73742d6576656e742d7631222c226831222c226931222c355d020000000000
    000000

LogicalSnapshotId = sha256(snapshot bytes)
                  = 5330745ce4c2a67abc33ef8a318cd1e9f1aa4188111605b675b8
                    aa3932adfe08
```

### 6.9 Automated-vector requirement

The implementation tests MUST generate these values through the normative
encoder of this specification and compare them byte-for-byte with the constants
in § 6.8 (entry bytes, normalized ordering, snapshot bytes, and `sha256`
`LogicalSnapshotId`). The constants are normative, not illustrative.

### 6.10 Ambiguity tests

The encoding is injective and order-independent where required:

- `["ab", "c"]` and `["a", "bc"]` produce different bytes (the string length
  prefix disambiguates nesting at the array level);
- `["a", ["b", "c"]]` and `[["a", "b"], "c"]` produce different bytes;
- record insertion order does not affect bytes (record keys are sorted by raw
  UTF-8 bytes);
- map insertion order does not affect bytes (map keys are sorted by raw UTF-8
  bytes);
- map keys `"z"`, `"aa"`, `"a"` encode in the order `"a"`, `"aa"`, `"z"`;
- `-0` and `+0` produce identical bytes;
- every NaN bit pattern normalizes to canonical NaN and produces identical
  bytes (and journal validation rejects NaN in authoritative values).

---

## 7. Local physical position

A separate local physical `JournalIndex` identifies one physical occurrence in
one replica's journal storage. It is:

- allocated from the single root-local allocator
  (`allocateLocalJournalIndex`, § 2.1) during serialized finalization;
- never part of `eventId`, logical order, snapshot equality, or normalization;
- used only by the public cursor API and by physical compaction.

Imported events and notification carriers are appended at fresh local physical
indices, strictly after the highest index the root-local allocator has ever
returned. Physical placement is host-local and is not required to converge
across hosts.

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
Physical compaction is serialized with both readers and occurrence writers.
Synchronization preserves the frozen local physical cursor domain.
Local event/occurrence indices come from one root-local monotonic allocator.
Failed inactive work may create gaps but can never cause event-ID reuse.
Every canonical map has exactly one normative key-order relation.
Every published test vector is produced by the same normalization and encoding
rules stated by the specification.
```
