# Notification journal types

## Closed action set

```text
JournalAction = "add" | "edit" | "delete" | "invalidate" | "validate"
```

The set is closed and has no generic `change` action. Its exact classifier is:

```text
add        iff absent -> materialized
edit       iff materialized -> materialized and before.value != after.value
              under normative ComputedValue equality
delete     iff materialized -> absent
invalidate iff materialized -> materialized and
              up-to-date -> potentially-outdated
validate   iff materialized -> materialized and
              potentially-outdated -> up-to-date
```

Add/delete never imply a freshness action. Edit never includes identifiers,
timestamps, validity relations, freshness, dependency metadata, representation,
or encoding when `ComputedValue` is equal. Independent value and freshness
transitions can emit two actions.

## Stable origin and synchronized clock

`JournalOriginId` is the durable identity of one independently writable replica
origin. It is unique among concurrent writers and survives process restart,
reset, migration, and active/inactive cutover. Both slots of one local graph
lineage carry the same identity. It is not regenerated per operation or sync.

```text
NotificationClock =
    Map<NodeKey, Map<JournalOriginId, ActionClock>>

ActionClock = {
    add:        NotificationComponent
    edit:       NotificationComponent
    delete:     NotificationComponent
    invalidate: NotificationComponent
    validate:   NotificationComponent
}

NotificationComponent = {
    sequence: uint64
    time: UnixTimestamp
}
```

An absent component has sequence zero. The action is its fixed map coordinate,
not mutable component metadata. A component's sequence is notification progress
only: it is not a graph revision/version, causal context, operation or
transaction identifier, or synchronization generation. Equal nonzero sequence
at the same coordinate has exactly one valid time. Overflow is fatal and never
wraps.

## Local delivery types and cursors

```text
DeliveryRecord = {
    localIndex: JournalIndex
    key: NodeKey
    action: JournalAction
    time: UnixTimestamp
}

DeliveryByIndex = Map<JournalIndex, DeliveryRecord>
DeliveryHead = Map<(NodeKey, JournalAction), JournalIndex>
```

`JournalIndex` is a monotonically allocated physical token in one process-local
cursor domain. `lastLocalJournalIndex` is its never-decreasing watermark. A
`PossibleNodeChange` containing a real index, or the sentinel returned by
`baselinePossibleNodeChange()`, is a cursor token. Tokens address local physical delivery progress, not synchronized clock
positions or graph versions. Sparse indices are valid because replacement deletes old records but
never reuses their indices.

`DeliveryHead[K,A]`, when present, points to the sole retained record for that
coordinate. `DeliveryRecord` contains no graph values, identifiers, timestamps
other than notification time, validity data, proofs, or graph assertions.

## Storage bound

Let `n` be current plus historic semantic keys, `r` the fixed configured origin
count, and `a = 5`. There are at most `n × r × a` clock components, `n × a`
heads, and `n × a` records, plus constant origin/watermark metadata. Thus:

```text
size = O(nra + na) = O(n) for fixed r and a
```

If origins are unbounded, the bound is `O(nr)`, not `O(n)`. Values and proofs are
not stored, so their size cannot affect journal size.
