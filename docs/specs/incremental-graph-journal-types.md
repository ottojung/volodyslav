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

## Stable writer ownership and synchronized clock

`JournalWriterId` is the durable identity of one independently writable host.
It MUST be a stable validated replica identity whose lifecycle and uniqueness
guarantees cover restart, reset, migration, and replica cutover. An unvalidated
transient hostname is not sufficient. A deployment may use an existing validated
replica fingerprint only if it has those guarantees; otherwise it provisions a
separate durable writer ID.

`JournalOriginId` is the durable counter namespace assigned to one writer.
Ownership is authoritative only through the finite immutable domain mapping:

```text
JournalDomain = {
    domainId: JournalDomainId
    writerOrigins: Map<JournalWriterId, JournalOriginId>
}

AllowedJournalOrigins = set(JournalDomain.writerOrigins.values())
```

All writer IDs are unique, all origin IDs are unique, no two writers map to one
origin, and every permitted writable host has exactly one mapping. The derived
`AllowedJournalOrigins` is useful for clock validation but is not the ownership
authority. Dynamic writer membership requires a separately specified domain
migration.

Every writable replica carries both `localWriterId` and `localJournalOrigin`.
Writable open and transaction finalization require:

```text
JournalDomain.writerOrigins[localWriterId] == localJournalOrigin
```

A missing domain, writer, or origin; a mismatched assignment; or duplicate
ownership prevents authoritative mutation. A host advances only its assigned
origin and retains but never advances other origins.

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

Writer identity and assignment survive restart, reset, migration, and same-host
active/inactive cutover. Remote snapshot import does not replace the receiving
writer or origin. When A's storage is copied to new writable host B, B retains
`JournalDomain` and every historical clock component, but before writable open:

```text
B.localWriterId = WB
B.localJournalOrigin = JournalDomain.writerOrigins[WB]
```

WB must be the distinct mapping provisioned for B. B never advances A's origin.
Copying storage alone does not transfer writer ownership.

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

Let `n` be current plus historic semantic keys, `a = 5`, and
`r = |set(writerOrigins.values())|`, a fixed domain constant.

```text
NotificationClock: at most n × r × a components
DeliveryHead:       at most n × a entries
DeliveryByIndex:    at most n × a records
total:              O(n)
```

Domain metadata, local origin, and the watermark add constant state. The
protocol rejects unbounded or unknown origins rather than admitting them.
Values and proofs are not stored, so their size cannot affect journal size.
