# Journal during migration

Migration builds the authoritative graph independently from journal history. An
inactive destination copies one fixed active snapshot of:

```text
durable local HostFingerprint
logical compacted JournalEntry collection
localJournalClock
receiver-local DeliveryByIndex, delivery heads, and cursor watermark
```

It validates authors, unique entry identity/content, required freshness
generation references to same-key add witnesses, canonical compaction,
clock watermark at least the greatest observed sequence, and local delivery
invariants before cutover. Migration never adopts a remote author identity.

Migration compares old and new authoritative graphs with the exact classifier:
add, unequal-value edit, delete, invalidate, and validate. Representation-only,
identifier-only, validity-only, and `Unchanged` transitions are silent. It
scopes every emitted invalidate/validate to the exact add generation of the
materialization whose freshness changed; an unresolved generation rejects the
migration. It reserves distinct local journal sequences after the observed
watermark and commits the new graph, immutable entries, and delivery records
atomically.
Aborted reservations may leave gaps and must never be reused.
