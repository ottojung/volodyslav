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

Event identity and payload integrity are defined once, in § 2.1 (INV-JT-01 and
INV-JT-02).

### 2.1 Event identity and origin

#### Content-addressed event identity

Event identity is content-addressed:

```text
canonicalEntryBytes(entry)
    = the complete canonical byte encoding of the entry (§ 6), with no eventId
      field

eventDigest = sha256(canonicalEntryBytes(entry))
eventId     = lowercase hexadecimal encoding of eventDigest
```

`eventId` is exactly 64 lowercase hexadecimal characters. There is exactly one
event-ID format and there are no sync-event IDs.

**INV-JT-01 (Logical identity):** `eventId` identifies a logical event's
immutable payload by content. Two occurrences with the same `eventId` denote
the same logical event, because an `eventId` is the digest of its payload. A
copied or repositioned event preserves its `eventId` and complete payload. A
SHA-256 collision is outside the supported protocol model and is treated as a
fatal cryptographic integrity failure. There is no event-ID-to-payload evidence
table and no retained digest basis.

**INV-JT-02 (Payload integrity):** An `eventId` is the content digest of its
immutable payload (INV-JT-01). Two occurrences with the same `eventId` denote
the same logical event; a payload disagreement under one `eventId` is therefore
impossible except as a SHA-256 collision, and synchronization rejects such an
exchange atomically.

Snapshot validation recomputes `sha256(canonicalEntryBytes(entry))` and rejects
an entry whose supplied `eventId` does not equal the recomputed value.

Ordering uses the raw 32-byte digest:

```text
stateOrder / freshnessOrder / snapshot entry ordering:
    compare eventDigest bytes lexicographically
```

Lexicographic ordering of the lowercase hexadecimal form is equivalent; raw
digest-byte order is the normative definition.

#### Origin

`origin` is provenance, not identity:

```text
origin = {
    hostname,
    originIndex,
}
```

`originIndex` is the original local physical `JournalIndex` allocated for the
event. `HostInstanceId` is not part of origin and is not retained: content
addressing already supplies identity.

#### Root-local physical/event allocator

`lastLocalJournalIndex` is **root-local durable allocator metadata**, shared by
both replica slots of one `RootDatabase` — not a per-replica field. Its
responsibilities are only:

- monotonic local physical positions;
- same-process cursor ordering;
- new occurrence allocation;
- preserving gaps after failed inactive work.

It is not part of logical event identity.

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
eventId = sha256(canonicalEntryBytes(entry))   // content-addressed
```

For imported events and carriers:

```text
eventId and immutable payload = preserved from the originating event
LocalJournalIndex = newly allocated locally
```

There is no separate `lastOriginIndex`. A failed inactive migration may advance
the root-local allocator and leave gaps, but it must never permit reuse of a
`(hostname, originIndex)` provenance tuple within one `RootDatabase` lineage.

Provenance-index uniqueness is scoped to one `RootDatabase` lineage: within a
lineage, no `(hostname, originIndex)` tuple is reused. No global uniqueness is
claimed across genuinely unrelated database reinitializations; such repetition
is harmless because origin is provenance only and `eventId` is content-addressed.

#### Failure guarantee for inactive work

```text
failed migration or synchronization destination build:
    active graph, active logical journal, active physical occurrences: unchanged
    root-local allocation watermark: may have advanced
```

The possible watermark advance is acceptable and required for uniqueness: no
retry within the same lineage may reuse a `(hostname, originIndex)` provenance
tuple.

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
watermark; no sequence reuses a `(hostname, originIndex)`
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

Each trace proves that no `(hostname, originIndex)` tuple is
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

Every logical event carries:

```text
eventId          = sha256(canonicalEntryBytes(entry)), 64 lowercase hex
origin           = { hostname, originIndex }            (provenance only)
key
time
action
logicalRevision
```

- `time` is wall-clock provenance for the public API. It is never used for
  conflict resolution.
- `creator` is derivable from `origin.hostname` and need not be stored
  separately.
- The `eventId` is not stored inside the entry bytes; it is recomputed as the
  digest of those bytes (§ 2.1) and compared and hashed through its derived
  value.

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

### Construction order for multi-entry batches

Content-addressed entries may refer to the event IDs of other entries emitted in
the same atomic batch. The proof map is part of an `add` or `edit` entry's
canonical bytes, so a state entry is not constructed until its proof map is
complete. Construction order is explicit and acyclic.

After darkroom reconciliation determines the final authoritative transition:

```text
1. Determine every new logical entry that may be required.

2. Reserve fresh root-local physical/origin indices for every host-originated
   new entry.

3. Determine the final selected state event for every input that will be
   referenced:
       - an existing selected state event; or
       - a new state event produced by this batch.

4. Traverse new state entries in dependency-topological order.

5. For each state entry K in that order:
       a. resolve the final eventId of every direct input;
       b. construct K.validInputStateEvents completely;
       c. construct every other immutable field of K;
       d. validate every field, including canonical-string validity;
       e. canonical-encode the complete entry;
       f. compute K.eventId;
       g. make K.eventId available to later dependent entries.

6. After all required state event IDs exist, construct freshness entries:
       a. resolve subjectStateEventId;
       b. construct the complete proof map;
       c. construct all other immutable fields;
       d. canonical-encode and hash the complete freshness entry.

7. Normalize the current journal plus the completed new entries.

8. Project and validate the resulting graph.

9. Commit the graph-cache mutations, completed entries, physical occurrences,
   and allocator watermark in the original atomic durable batch.
```

No entry may be hashed while any hashed field is missing, tentative, or subject
to later mutation. In particular, it is invalid to hash an `add` or `edit`
entry and then add or modify one of its proof references: the proof map is part
of the entry's canonical bytes, so any such change would produce a different
event ID after the fact.

The graph schema is a DAG, so the dependency-topological traversal is acyclic. A
dependency cycle is rejected by the existing schema rules rather than handled by
the journal encoder.

#### Same-batch construction trace

Both `A` and its dependent `D` are newly materialized in one migration or reset
batch:

```text
allocate origins for add(A) and add(D)

add(A):
    complete proof map
    complete canonical bytes
    eventId A1 = sha256(bytes)

add(D):
    validInputStateEvents[A] = A1
    complete canonical bytes
    eventId D1 = sha256(bytes)
```

A freshness entry for `D1` is constructed only after `D1` exists (step 6): its
`subjectStateEventId` is `D1` and its proof map references the resolved input
state event IDs, all of which exist by then.

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

The reasons include content-identity semantics:

- equal `eventId`s are equal immutable payloads by content addressing
  (INV-JT-01), so deduplication by `eventId` never merges two different
  payloads and normalization cannot lose information needed for future
  payload-integrity checking — the discarded entry's identity would differ from
  any conflicting future entry's identity;
- a non-maximal state entry can never become maximal after adding more entries,
  because `stateOrder` is a total order and adding entries cannot increase an
  existing entry's position;
- a freshness entry for a non-selected state can never become applicable later,
  because state selection never moves backwards once it is fixed by the maximum;
- a non-maximal freshness entry for the selected state can never become maximal
  after adding more entries, for the same total-order reason.

#### Old-model counterexample (regression test)

The origin-derived ID model made the law false:

```text
A contains:
    E1 with origin-derived ID e
    later winning state W
normalization discards E1

B contains:
    E2 with the same old origin-derived ID e
    different payload
```

The old model gave:

```text
normalize(A ∪ B) -> reject        (E1 and E2 share ID e, different payloads)
normalize(normalize(A) ∪ B) -> accept   (E1 already discarded)
```

Under content addressing this discrepancy cannot occur: `E1` and `E2` are
different immutable payloads, so they necessarily have different SHA-256
digests and therefore different `eventId`s. Discarding a losing event never
hides a future payload conflict, because the discarded event's identity is
content-derived and would not collide with any different payload.

---

## 6. Canonical serialization

`eventId` is the final state/freshness conflict tie-breaker and `LogicalSnapshotId`
is a digest of the canonical encoding, so the encoding is normative and
executable. "Canonical encoding" always means this single fully specified byte
format; there is no other encoding. Two implementations that encode the same
logical journal must produce byte-identical serializations.

### 6.1 Primitives

#### Canonical string domain

Every string that appears in canonical bytes belongs to the accepted domain:

```text
CanonicalString =
    a well-formed sequence of Unicode scalar values
```

For a JavaScript implementation:

```text
A string is valid exactly when it contains no unpaired UTF-16 surrogate code
unit.
```

Use `String.prototype.isWellFormed()` where available, or an equivalent explicit
validator, and reject malformed strings before any hashing or encoding. The
encoding is:

```text
bytes(s) =
    RFC 3629 UTF-8 encoding of the Unicode scalar sequence s
```

No Unicode normalization is performed: NFC is not applied, NFD is not applied,
and case folding is not applied. Two well-formed strings with different scalar
sequences remain different logical strings even when Unicode considers them
canonically equivalent.

The well-formedness requirement applies to every string in canonical bytes:

```text
hostname
NodeKey
NodeIdentifier
schemaVersion
mergeProtocolVersion
SimpleValue string values
SimpleValue record keys
proof-map input keys
subjectStateEventId
eventId text when embedded in a snapshot pair or proof
```

`eventId` and proof IDs must additionally satisfy:

```text
exactly 64 lowercase ASCII hexadecimal characters
```

Snapshot validation and local event creation reject malformed strings before
hashing.

#### Canonical string tests

```text
U+FFFD:
    "\uFFFD"
    valid
    UTF-8 = efbfbd

unpaired high surrogate:
    "\uD800"
    invalid

unpaired low surrogate:
    "\uDC00"
    invalid

embedded unpaired surrogate:
    "a\uD800b"
    invalid

valid surrogate pair:
    "\uD83D\uDE00"
    valid
    UTF-8 = f09f9880
```

Regression test for the old ambiguity: common JavaScript UTF-8 encoders replace
malformed surrogates with `U+FFFD`, so `Buffer.from("\uD800", "utf8")` and
`Buffer.from("\uFFFD", "utf8")` both commonly produce `efbfbd`. The protocol
rejects the former before encoding, so two different accepted payloads can no
longer share bytes for this reason.

#### Framing primitives

One byte order is used everywhere, big-endian:

```text
u32(n) = four-byte unsigned big-endian integer
u64(n) = eight-byte unsigned big-endian integer
```

```text
bytes(s)  = RFC 3629 UTF-8 bytes of the well-formed scalar sequence s
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
self-delimiting fields. The `eventId` is NOT included in the entry bytes: it is
the SHA-256 digest of those bytes (§ 2.1), recomputed during ordering, integrity
checks, and snapshot validation.

```text
origin = array([string(hostname), u64(originIndex)])
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

`eventId` is the lowercase hexadecimal encoding of the SHA-256 digest of the
entry bytes:

```text
canonicalEntryBytes(entry)  // § 6.4, no eventId field
eventId = lowercase hex(sha256(canonicalEntryBytes(entry)))
```

It is exactly 64 lowercase hexadecimal characters. Ordering in `stateOrder`,
`freshnessOrder`, and snapshot entry ordering compares the raw 32-byte digest
lexicographically (equivalent to lexicographic comparison of the lowercase hex
form). `string(eventId)` is used when an `eventId` is embedded inside another
byte encoding (proof maps, snapshot pairs, `subjectStateEventId`).

### 6.6 Immutable payload equality

Two logical events are payload-equal exactly when their full canonical
serialization bytes are equal (variant tag plus all fields). The integrity check
of INV-JT-02 compares these bytes.

### 6.7 Snapshot byte sequence

Each normalized entry is carried as a self-delimiting pair of its `eventId`
(the 64-character lowercase hex digest) and its canonical entry bytes, so the
receiver can recompute and validate the digest:

```text
entryPair(entry) =
    array([ string(eventId), canonicalEntryBytes(entry) ])

snapshotBytes =
    array([
        string("logical-snapshot"),
        u64(1),                        // canonical-encoding version
        string(schemaVersion),
        string(mergeProtocolVersion),
        array([
            entryPair for each normalized entry,
            sorted by raw eventDigest bytes,
        ]),
    ])

LogicalSnapshotId = sha256(snapshotBytes)
```

`validateLogicalSnapshot` recomputes `sha256(canonicalEntryBytes(entry))` for
every pair and rejects a pair whose supplied `eventId` differs from the
recomputed digest.

### 6.8 Fixed test vectors

All vectors use schema `"schema-1"`, protocol `"proto-1"`, origin
`{ hostname, originIndex }`, the entry layout of § 6.4 with big-endian `u64`
framing, raw-UTF-8 map-key ordering, and the variant tags `add=0x11`,
`edit=0x12`, `delete=0x13`, `validate=0x14`, `invalidate=0x15`. Event IDs are
SHA-256 digests of the entry bytes. The bytes below were generated by the
normative encoding described in this section.

#### Vector 1 — Entry encoding and content-addressed IDs

Five independent entries; every variant begins with its correct tag, and every
`eventId` is `sha256(entryBytes)`:

```text
add:
  origin ("h1",5), key "k", time 1000, revision 1, id "n1",
  value 1, createdAt 1000, modifiedAt 1000, up-to-date, proof {}
  tag 0x11
  eventId = 3ab2b709300aca87e2757b78ea317779bce6b718fe120c36caac0219ded5e119
  hex = 11000000000000000200000000000000026831000000000000000500000000
        000000016b00000000000003e8000000000000000100000000000000026e31
        023ff000000000000000000000000003e800000000000003e8010000000000
        000000

edit:
  origin ("h1",6), key "k", time 2000, revision 2, id "n1",
  value 2, createdAt 1000, modifiedAt 2000, potentially-outdated,
  proof { "a" -> eventId(add) }
  tag 0x12
  eventId = a308361e9514221b4a24c9e9404bbf0a2b032dc0d15a481892e1f0b4a79c64cb
  hex = 12000000000000000200000000000000026831000000000000000600000000000000016b
        00000000000007d0000000000000000200000000000000026e3102400000000000000000
        000000000003e800000000000007d0020000000000000001000000000000000161000000
        000000004033616232623730393330306163613837653237353762373865613331373737
        396263653662373138666531323063333663616163303231396465643565313139

validate:
  origin ("h1",7), key "k", time 1500, revision 1,
  subject = eventId(add), up-to-date,
  proof { "a" -> eventId(add) }
  tag 0x14
  eventId = 05badd93d8d16814f2ceace25a8263508d6f37ca115e6ce08eef8f295f56b8e2
  hex = 14000000000000000200000000000000026831000000000000000700000000
        000000016b00000000000005dc000000000000000100000000000000403361
        62326237303933303061636138376532373537623738656133313737373962
        63653662373138666531323063333663616163303231396465643565313139
        01000000000000000100000000000000016100000000000000403361623262
        37303933303061636138376532373537623738656133313737373962636536
        62373138666531323063333663616163303231396465643565313139

invalidate:
  origin ("h1",8), key "k", time 1100, revision 1,
  subject = eventId(add), potentially-outdated, proof {}
  tag 0x15
  eventId = 9505e7dea832486f9e88aeaec0ffa963ab59158d6e5bd49c0b1bdb25d29771bd
  hex = 15000000000000000200000000000000026831000000000000000800000000
        000000016b000000000000044c000000000000000100000000000000403361
        62326237303933303061636138376532373537623738656133313737373962
        63653662373138666531323063333663616163303231396465643565313139
        020000000000000000

delete:
  origin ("h1",9), key "k", time 3000, revision 1, id "n1"
  tag 0x13
  eventId = 36c6eb5ceb50a63bffc5299c1db0fdfccc358a81bcb6c13504d28aee5c0e93f5
  hex = 13000000000000000200000000000000026831000000000000000900000000
        000000016b0000000000000bb8000000000000000100000000000000026e31
```

#### Vector 2 — Normalization

Input:

```text
A = add, origin ("h1",5), key "k", time 1000, revision 1, id "n1",
    value 1, createdAt 1000, modifiedAt 1000, up-to-date, proof {}
    eventId = 3ab2b709300aca87e2757b78ea317779bce6b718fe120c36caac0219ded5e119
B = invalidate, origin ("h1",6), subject = eventId(A), stale, proof {}
    eventId = 4198230ebaf02f94c1a97d32bb8debf1fb6e9a01309000729206543d112ce837
C = edit, origin ("h1",7), key "k", time 2000, revision 2, id "n1",
    value 2, createdAt 1000, modifiedAt 2000, potentially-outdated,
    proof { "a" -> eventId(A) }
    eventId = c1e418fd81eb737f4288554733c07f8a40e7d148b6e6d9a4de8132da4faf4778
```

`normalizeJournal({A, B, C}) = [C]`: `C` defeats `A` by `stateOrder`
(`(2, eventId C) > (1, eventId A)`), and `B` is not applicable to `C` because
its `subjectStateEventId` is `eventId(A)`, not `eventId(C)`.

```text
C bytes hex = 120000000000000002000000000000000268310000000000000007000
    00000000000016b00000000000007d0000000000000000200000000000000026e31
    02400000000000000000000000000003e800000000000007d00200000000000000
    01000000000000000161000000000000004033616232623730393330306163613837
    653237353762373865613331373737396263653662373138666531323063333663
    616163303231396465643565313139

snapshot bytes hex = 000000000000000500000000000000106c6f676963616c2d736e617073686f74000000000000
    00010000000000000008736368656d612d31000000000000000770726f746f2d310000000000
    0000010000000000000002000000000000004063316534313866643831656237333766343238
    3835353437333363303766386134306537643134386236653664396134646538313332646134
    6661663437373812000000000000000200000000000000026831000000000000000700000000
    000000016b00000000000007d0000000000000000200000000000000026e3102400000000000
    000000000000000003e800000000000007d00200000000000000010000000000000001610000
    0000000000403361623262373039333030616361383765323735376237386561333137373739
    6263653662373138666531323063333663616163303231396465643565313139

LogicalSnapshotId = sha256(snapshot bytes)
                  = 36ab90bf2d8695aed9650c3e7d29f61cdd210205159bd9c05ccce
                    7bf5ce5e115
```

#### Vector 3 — Applicable freshness

Input:

```text
A = add, origin ("h1",5), key "k", time 1000, revision 1, id "n1",
    value 1, createdAt 1000, modifiedAt 1000, up-to-date, proof {}
B = invalidate, origin ("h1",6), subject = eventId(A), stale, proof {}
```

`normalizeJournal({A, B}) = [A, B]` (A is the selected state; B is applicable
because its subject is `eventId(A)`). Snapshot entry ordering by raw eventDigest
bytes is `A` (`0x3a...`) before `B` (`0x41...`).

```text
A bytes hex = 110000000000000002000000000000000268310000000000000005000
    00000000000016b00000000000003e8000000000000000100000000000000026e31
    023ff000000000000000000000000003e800000000000003e80100000000000000
    00

B bytes hex = 150000000000000002000000000000000268310000000000000006000
    00000000000016b000000000000044c0000000000000001000000000000004033
    616232623730393330306163613837653237353762373865613331373737396263
    653662373138666531323063333663616163303231396465643565313139020000
    000000000000

snapshot bytes hex = 000000000000000500000000000000106c6f676963616c2d736e617073686f74000000000000
    00010000000000000008736368656d612d31000000000000000770726f746f2d310000000000
    0000020000000000000002000000000000000403361623262373039333030616361383765323
    7353762373865613331373737396263653662373138666531323063333663616163303231396
    4656435653131391100000000000000020000000000000002683100000000000000050000000
    000000016b00000000000003e8000000000000000100000000000000026e31023ff000000000
    000000000000000003e800000000000003e80100000000000000000000000000000002000000
    0000000040343139383233306562616630326639346331613937643332626238646562663166
    6236653961303133303930303037323932303635343364313132636538333715000000000000
    00020000000000000002683100000000000000060000000000000016b000000000000044c000
    0000000000001000000000000004033616232623730393330306163613837653237353762373
    8656133313737373962636536623731386665313230633336636161633032313964656435653
    13139020000000000000000

LogicalSnapshotId = sha256(snapshot bytes)
                  = 0b33c627435e66fa811716da3cf96a531a27f1ded577c12c2ef15
                    34fab17d217
```

### 6.9 Content-identity vectors

- **Same immutable payload -> same eventId:** encoding the same entry bytes
  twice yields the same SHA-256 digest.
- **One-byte payload change -> different eventId:** the add entry with value
  `7` (`eventId c842f6e271e6e5590b0648064fe8033e036cf387005ae1e0f00290ab
  259697d1`) differs from the add entry with value `8` (`eventId 54f524cdfed
  956d3154574f5ef4728fb9973ac108d20dc442faff242bb82457a`).
- **Copied physical occurrence -> same eventId:** a copy preserves the entry
  bytes, so its digest is unchanged.
- **Notification carrier -> same eventId:** a carrier is a duplicate occurrence
  of a canonical event with identical entry bytes.
- **Different local physical position of a copy -> same eventId:** the physical
  `JournalIndex` is not part of the entry bytes; only `originIndex` (the
  original position) is, and a copy preserves it.
- **Normalization followed by future union cannot hide an ID/payload
  conflict:** because an `eventId` is the digest of its payload, a discarded
  losing event cannot collide with any different future payload.

### 6.10 Automated-vector requirement

The implementation tests MUST generate these values through the normative
encoder of this specification and compare them byte-for-byte with the constants
in § 6.8 and § 6.9 (entry bytes, event IDs, normalized ordering, snapshot
bytes, and `sha256` `LogicalSnapshotId`). The constants are normative, not
illustrative.

### 6.11 Ambiguity tests

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
- for every `entryPair`, the supplied `eventId` equals
  `sha256(canonicalEntryBytes(entry))` (the content digest, § 2.1 and § 6.7);
- a valid `origin` (hostname plus a `u64` origin index in domain) and the
  derived `eventId` format (exactly 64 lowercase hexadecimal characters);
- every string in the snapshot is a well-formed canonical string (§ 6.1):
  no unpaired UTF-16 surrogate code unit, and `eventId`/proof IDs are exactly
  64 lowercase ASCII hexadecimal characters;
- valid `logicalRevision` and `time` domains;
- valid `NodeKey` and `NodeIdentifier` forms;
- canonical proof maps with no duplicate keys;
- a freshness entry whose `subjectStateEventId` belongs to the same semantic
  key as the entry;
- a valid action/tone/payload combination (for example, `validate` always
  pairs with `tone = "up-to-date"`, `invalidate` with
  `"potentially-outdated"`).

Because an `eventId` is the digest of its payload, equal `eventId`s
automatically carry equal payloads (INV-JT-01); a digest mismatch is rejected
before any union.

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
Within one RootDatabase lineage, no (hostname, originIndex) provenance tuple is
reused.
Every published projected graph satisfies the complete IncrementalGraph storage
and validity invariants.
Canonical serialization determines one exact byte sequence.
Physical compaction deletes only exact physical indices proven redundant.
Synchronization preserves the frozen local physical cursor domain.
Local event/occurrence indices come from one root-local monotonic allocator.
Failed inactive work may create gaps but can never cause event-ID reuse.
Every canonical map has exactly one normative key-order relation.
Every published test vector is produced by the same normalization and encoding
rules stated by the specification.
Event identity is the SHA-256 digest of the complete immutable entry payload.
Origin is provenance, not identity.
Normalization can permanently discard losing events without losing future
integrity evidence.
The normalization law includes content-identity semantics, not only maximum
selection.
Compaction mutates the physical journal only through exact deletes.
Compaction never replaces, truncates, or rewrites retained occurrences.
A concurrent append cannot belong to a previously calculated delete set.
Synchronization copies one fixed committed physical source view.
Any operation reading an active physical journal while compaction may run is a
shared garden reader.
Synchronization never upgrades enterGarden to closeGarden.
Every string accepted by canonical serialization is a well-formed Unicode
scalar sequence.
Canonical UTF-8 encoding never replaces malformed surrogate code units;
malformed strings are rejected.
All event-ID references are exactly 64 lowercase hexadecimal characters.
Entries that reference other entries from the same batch are hashed in an
acyclic dependency order before the atomic commit.
No event is hashed before its complete canonical payload, including its proof
map, is final.
Same-batch state references are resolved in dependency-topological order.
A migration begins from the active canonical journal, not from an empty journal.
Migration result:
    J1 = normalizeJournal(J0 ∪ migrationEvents)
Migration target graph:
    projectGraph(newSchema, J1)
An unchanged KEEP may emit no event only because its existing canonical event is
carried into J1.
Any lifecycle operation that reads the active physical journal while compaction
may run captures that source under enterGarden.
```
