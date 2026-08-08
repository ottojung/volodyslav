# IncrementalGraph journal types

## Logical replicated journal

The journal is notification and history infrastructure. It is not authoritative
graph state: current values, materialization, freshness, timestamps, and
validity come from the IncrementalGraph.

```text
JournalAction = "add" | "edit" | "delete" | "invalidate" | "validate"

JournalEntry = ValueOrPresenceEntry | FreshnessEntry

ValueOrPresenceEntry = {
    author: HostFingerprint
    sequence: uint64
    key: NodeKey
    action: "add" | "edit" | "delete"
    time: UnixTimestamp
}

FreshnessEntry = {
    author: HostFingerprint
    sequence: uint64
    key: NodeKey
    action: "invalidate" | "validate"
    time: UnixTimestamp
    generation: JournalEntryId
}

JournalEntryId(E) = (E.sequence, E.author)
```

Entry IDs are ordered lexicographically, sequence first and author second.
`HostFingerprint` is the durable writer fingerprint established by the host
lifecycle. It is not a hostname. `NodeIdentifier` already embeds its allocating
host fingerprint and receives no additional discriminator.

There is no separate journal membership domain. Supported host creation allocates one
globally unique durable `HostFingerprint`; restoration may resume it only from
that host's current synchronized state, and reset, migration, and copying never
transfer ownership. Synchronization validates that every author is a
well-formed supported host fingerprint and that one `JournalEntryId` has only
one immutable content. Duplicate ownership or rollback under the same author is
unsupported and prevents writable open.

Entries are immutable. A remotely learned entry is imported byte-for-byte with
the same author and sequence. Learning an entry never re-authors it.

`FreshnessEntry.generation` is the exact `JournalEntryId` of the `add` which
established the materialization whose freshness changed. It is required for
invalidate and validate and forbidden on add, edit, and delete. This reference
is journal history only and is never stored on a graph materialization.

Journal validation rejects a freshness entry unless its generation resolves to
a valid logical add for the same key in the merge input. Compaction retains an
add-reference witness for every retained freshness notification. It may discard
additional freshness authority for a losing generation only after proving that
the generation can never again become the winning presence generation, as
specified by the compaction rules.

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

## Physical delivery state

`JournalEntryId` is distinct from a receiver-local cursor position. A host may
maintain `DeliveryByIndex`, per-coordinate delivery heads, and a monotonically
increasing local watermark so `possibleMaybeChanges()` can expose newly learned
history. Delivery records are self-contained:

```text
DeliveryRecord = {
    localIndex: receiver-local cursor position
    key: NodeKey
    action: JournalAction
    time: UnixTimestamp
    causeId?: JournalEntryId
}
```

`key`, `action`, and `time` are copied into the record when delivery is created.
`causeId` is optional provenance/debugging information and may outlive logical
compaction of that entry; public queries never dereference it. Those indexes are
local, opaque, same-process delivery infrastructure;
they are neither replicated identity nor causal order. A receiving host assigns
a new delivery position while retaining the imported logical entry unchanged.

## Persisted graph boundary

Materializations remain exactly the graph concepts `values`, `freshness`, real
wall-clock `timestamps { createdAt, modifiedAt }`, identifier lookup,
`NodeIdentifier`, and `valid`. They contain no journal entry ID, virtual time,
revision stamp, support vector, epoch, vector clock, or synchronization field.
Synchronization never advances `modifiedAt` merely because bytes were copied.

The logical storage bound is
`O(number_of_historic_keys × writers × 5)`: compaction retains each coordinate
maximum plus only constant-many winning-generation freshness and add-reference
witnesses, apart from local cursor infrastructure. The bound is independent of
the number of historical generations. Entries contain no graph value, support
vector, or validity proof.
