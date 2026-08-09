# IncrementalGraph journal types

## Logical replicated journal

The journal is notification and history infrastructure. It is not authoritative
graph state: current values, materialization, freshness, timestamps, and
validity come from the IncrementalGraph.

```text
JournalEntry =
    AddJournalEntry
  | DeleteJournalEntry
  | EditJournalEntry
  | InvalidateJournalEntry
  | ValidateJournalEntry

JournalEntryBase = {
    author: HostFingerprint
    sequence: uint64
    key: NodeKey
    time: UnixTimestamp
}

AddJournalEntry = JournalEntryBase & { action: "add" }
DeleteJournalEntry = JournalEntryBase & { action: "delete" }

GenerationScopedJournalEntryBase = JournalEntryBase & {
    generation: JournalEntryId
}

EditJournalEntry =
    GenerationScopedJournalEntryBase & { action: "edit" }
InvalidateJournalEntry =
    GenerationScopedJournalEntryBase & { action: "invalidate" }
ValidateJournalEntry =
    GenerationScopedJournalEntryBase & { action: "validate" }

JournalEntryId(E) = (E.sequence, E.author)
```

Entry IDs are ordered lexicographically, sequence first and author second.
`HostFingerprint` is the durable writer fingerprint established by the host
lifecycle. It is not a hostname. `NodeIdentifier` already embeds its allocating
host fingerprint and receives no additional discriminator.

There is no separate journal membership domain. Supported host creation
allocates one globally unique durable `HostFingerprint`; restoration may resume
it only from that host's current synchronized state. Reset, migration, and
copying never transfer ownership. Synchronization validates that every author
is a well-formed supported host fingerprint and that one `JournalEntryId` has only
one immutable content. Duplicate ownership or rollback under the same author is
unsupported and prevents writable open.

The journal has no fixed closed writer-membership domain. A supported new host
may introduce a new durable `HostFingerprint`, so storage is not bounded
independently of the number of durable authors represented in retained history.

Entries are immutable. A remotely learned entry is imported byte-for-byte with
the same author and sequence. Learning an entry never re-authors it.

The union makes generation membership structural rather than optional.
`generation` is the exact `JournalEntryId` of the same-key `AddJournalEntry`
which established the materialization incarnation being edited, invalidated, or
validated. `AddJournalEntry` and `DeleteJournalEntry` have no `generation`
field; each of the other three variants requires it. This reference is journal
history only and is never stored on a graph materialization.

For example, if `G1=(10,A)` is an add for K, every edit, invalidate, and validate
for that incarnation contains `generation=(10,A)`, while a delete for K has no
generation field. After a delete and later add `G2=(50,B)`, subsequent scoped
events for the new incarnation contain `generation=(50,B)`. Events scoped to G1
are inapplicable to G2.

Action variant and authorship context are orthogonal. Ordinary mutation,
migration, synchronization-authored destruction, and controlled reset all use
these same variants without an origin discriminator. In particular,
synchronization may author `DeleteJournalEntry` or an
`InvalidateJournalEntry` carrying its required generation; normal
synchronization never authors add, edit, or validate, while reset may author
fresh add generations.

Journal validation rejects an entry with action edit, invalidate, or validate
unless its generation resolves to a valid same-key add in the merge input.
Compaction retains an add-reference witness for every retained generation-scoped
notification. It may discard additional value/freshness authority for a losing
generation only after proving that the generation can never again become the
winning presence generation, as specified by the compaction rules.

## Closed action classifier

```text
add        iff absent -> materialized
edit       iff materialized -> materialized and ComputedValue changes
delete     iff materialized -> absent
invalidate iff up-to-date -> potentially-outdated
validate   iff potentially-outdated -> up-to-date
```

There is no generic `change`. Identifier, timestamp, validity-only, dependency,
or representation changes are not edits. `Unchanged` emits no edit. Value and
freshness transitions may emit two entries when both classifiers apply.

This classifier governs ordinary graph mutation and synchronization. Controlled
reset is the sole administrative re-generation operation: it emits `add` for
every target-materialized key, including a key that was already materialized,
and `delete` for every known historic key the target leaves absent. These
entries deliberately establish fresh presence frontiers. Reset uses the same
`JournalEntry` shape; there is no reset-specific action or record type.

## Host-local journal clock

Each writable host owns one persistent `localJournalClock: uint64`, protected
by a dedicated allocator mutex. It is a journal-only Lamport-style clock, not a
graph clock and not a per-node counter.

1. Sequences are never reused, including after an aborted reservation.
2. Importing or observing entries raises the allocator watermark to at least
   their maximum sequence.
3. Allocation increments the watermark and uses the result.
4. Consequently, if `E2` is authored after observing `E1`, then
   `E2.sequence > E1.sequence`.
5. Concurrent authors may use the same sequence; author breaks the tie.
6. Overflow is fatal and wrapping is forbidden.

## Stored entries and receiver-local cursor metadata

Each retained logical entry is stored exactly once:

```text
StoredJournalEntry = {
    entry: JournalEntry
    localIndex: uint64
}

journal.entries: Map<JournalEntryId,StoredJournalEntry>
localJournalIndexWatermark: uint64
```

`JournalEntry.sequence` is the replicated logical event coordinate. The author
allocates it from `localJournalClock`; it travels unchanged with the entry and,
together with `author`, forms `JournalEntryId`.

`StoredJournalEntry.localIndex` is the receiver-local
`possibleMaybeChanges()` position. Its receiver allocates it from
`localJournalIndexWatermark`; it never replicates and may change when the
existing stored entry is touched. It is not part of `JournalEntry`,
`JournalEntryId`, replicated serialization, logical equality, Lamport ordering,
provenance, graph revision identity, compaction selection, or synchronization.
Thus `localJournalClock` is the allocator/watermark for the one distributed
logical sequence, while `localJournalIndexWatermark` is the allocator/watermark
for a receiver's notification positions. They are not competing logical journal
sequences. Both overflow fatally, and neither allocator reuses a value.

A previously unknown logical entry installed locally keeps its immutable contents
byte-for-byte and receives:

```text
localJournalIndexWatermark += 1
stored.localIndex = localJournalIndexWatermark
```

A sender's index is never imported. Receiving an already-known entry does not
move it. `touch(E)` increments the local index watermark and updates only E's
single stored `localIndex`; it never deletes, duplicates, replaces, or re-authors
E's logical contents. A reconstructible secondary index is permitted only as a
local optimization and has no synchronization meaning.

Every retained entry has exactly one local index; retained indexes are unique;
the watermark covers every retained index; gaps are harmless; and indexes are
never reused in one receiver cursor domain. Index allocation/update commits
atomically with the graph and journal transaction which requires it. Active
transactions read the committed index watermark and allocate/update indexes
while holding the per-replica darkroom commit mutex, never before acquiring it.

## Persisted graph boundary

Materializations remain exactly the graph concepts `values`, `freshness`, real
wall-clock `timestamps { createdAt, modifiedAt }`, identifier lookup,
`NodeIdentifier`, and `valid`. They contain no journal entry ID, virtual time,
revision stamp, support vector, epoch, vector clock, or synchronization field.
Synchronization never advances `modifiedAt` merely because bytes were copied.

For storage analysis:

```text
n = number of current or historic semantic node keys represented by the
    database/journal
r = number of distinct durable authors represented by retained journal history
a = 5 journal actions, a fixed constant
```

The fixed finite schema bounds node arity, and the maximum serialized size of a
`ConstValue` is treated as a fixed system constant. Consequently a `NodeKey`,
including its bounded-arity binding values, has constant size in this analysis.

The logical storage bound is `O(nr)`: compaction retains constant-many entries
per relevant `(author,key,action)` coordinate plus constant-many winning-
generation value/freshness and add-reference witnesses. Each entry stores one
scalar local index; touches create no records. Operation count, synchronization
count, database age, historic generation count, and touch count add no unbounded
multiplicative term, and the same bound applies to any reconstructible secondary
index. Entries contain no `ComputedValue`, support/provenance vector, or validity
proof. Because author membership is open, no writer-independent `O(n)` bound is
promised.
