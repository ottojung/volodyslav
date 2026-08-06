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

`JournalDomainId` is the durable identity of one synchronization domain.
`AllowedJournalOrigins` is a finite immutable set. This protocol version fixes
membership:

```text
JournalDomain = {
    domainId: JournalDomainId
    allowedOrigins: AllowedJournalOrigins
}

AllowedJournalOrigins = finite immutable set<JournalOriginId>
```

`JournalOriginId` is the assigned writer identity of exactly one independently
writable host. Every writable host has one unique origin from a fixed finite
synchronization domain. Unknown origins cannot enlarge a clock. A host advances
only its assigned local origin; it retains but never advances other origins.

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

Origin identity obeys these lifecycle rules:

```text
process restart: preserve local origin
reset: preserve local origin
migration: preserve local origin
active/inactive cutover on the same host: both slots share the local origin
remote snapshot import: do not replace the receiving host's local origin
new independently writable host:
    assign a distinct allowed origin before its first graph mutation
```

A copied database does not transfer writer identity. A receiving host retains
all synchronized clock components but uses only its own assigned origin for
subsequent mutations. Adding or removing writable origins requires a separately
specified journal-domain migration; dynamic membership is outside this protocol
revision.

Writable open and transaction finalization require
`localJournalOrigin ∈ JournalDomain.allowedOrigins`. Missing domain, missing
local origin, or an origin outside the fixed set prevents authoritative graph
mutation. If A's storage is copied to a new writable host B, B must be
provisioned with a distinct allowed origin before opening the graph for writes;
B retains A's clock components but never advances them.

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
`r = |allowedOrigins|`, a fixed domain constant.

```text
NotificationClock: at most n × r × a components
DeliveryHead:       at most n × a entries
DeliveryByIndex:    at most n × a records
total:              O(n)
```

Domain metadata, local origin, and the watermark add constant state. The
protocol rejects unbounded or unknown origins rather than admitting them.
Values and proofs are not stored, so their size cannot affect journal size.
