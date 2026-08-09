# IncrementalGraph journal types

## Logical replicated journal

The journal is notification and history infrastructure. It is not authoritative
graph state: current values, materialization, freshness, timestamps, and
validity come from the IncrementalGraph.

```text
JournalAction = "add" | "edit" | "delete" | "invalidate" | "validate"

JournalEntry = {
    author: HostFingerprint
    sequence: uint64
    key: NodeKey
    action: JournalAction
    time: UnixTimestamp
    generation?: JournalEntryId
}

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

Entries are immutable. A remotely learned entry is imported byte-for-byte with
the same author and sequence. Learning an entry never re-authors it.

`generation` is the exact `JournalEntryId` of the add which established the
materialization being edited, invalidated, or validated. It is required exactly
for edit, invalidate, and validate and forbidden for add and delete. This
reference is journal history only and is never stored on a graph materialization.

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

`localIndex` is receiver-local metadata only. It is not part of `JournalEntry`,
`JournalEntryId`, replicated serialization, logical equality, Lamport ordering,
provenance, graph revision identity, compaction selection, or synchronization.
`localJournalClock` allocates logical sequences; the distinct
`localJournalIndexWatermark` allocates cursor positions. Both overflow fatally,
and neither allocator reuses a value.

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
atomically with the graph and journal transaction which requires it.

## Persisted graph boundary

Materializations remain exactly the graph concepts `values`, `freshness`, real
wall-clock `timestamps { createdAt, modifiedAt }`, identifier lookup,
`NodeIdentifier`, and `valid`. They contain no journal entry ID, virtual time,
revision stamp, support vector, epoch, vector clock, or synchronization field.
Synchronization never advances `modifiedAt` merely because bytes were copied.

The logical storage bound is
`O(number_of_historic_keys × writers)`: compaction retains each coordinate
maximum plus only constant-many winning-generation value/freshness and
add-reference witnesses. Each stores exactly one scalar local index; touches
create no records. The bound is independent of historical generations and touch
count, and applies to any reconstructible secondary index. Entries contain no
graph value, support vector, or validity proof.
