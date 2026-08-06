# Notification journal during migration

Migration constructs the authoritative graph independently from journal data.
The inactive destination first copies the active local journal infrastructure
exactly from one fixed snapshot:

```text
JournalDomain
localWriterId
NotificationClock
DeliveryByIndex
DeliveryHead
JournalOriginId
lastLocalJournalIndex
```

Migration preserves this complete local domain and the receiving writer
identity; it never creates, replaces, or infers a domain. Before cutover it
validates domain equality with the source, membership of the local and all clock
origins, equality of the local writer/origin pair with `writerOrigins`, the
one-head invariant, and that the watermark is at least every
retained delivery index.

It then compares old and new authoritative graphs and applies the ordinary exact
classifier: absent→present `add`, present→absent `delete`, unequal materialized
values `edit`, fresh→stale `invalidate`, and stale→fresh `validate`. A key can
produce both value and freshness actions. Representation-only changes produce
nothing.

Migration is a local authoritative graph mutation, so each classified action
advances the local origin clock and append-or-replaces local delivery state. The
new graph plus these changes commit atomically. Migration does not seed the graph
from journal data or create materialization assertions.

## Trace

If old K is present with value A/fresh and new K is present with value B/stale,
migration emits `edit` and `invalidate`, advances both coordinates, and retains
one head for each. If only its encoding changes, it emits none. Origin identity
and watermark survive; any new records use strictly greater indices.
