# Journal during migration

Migration builds the authoritative graph independently from journal history. An
inactive destination copies one fixed active snapshot of:

```text
durable local HostFingerprint
logical compacted JournalEntry collection
localJournalClock
receiver-local DeliveryByIndex, delivery heads, and cursor watermark
```

It validates authors, unique entry identity/content, required edit/freshness
generation references to same-key add witnesses, canonical compaction,
clock watermark at least the greatest observed sequence, and local delivery
invariants before cutover. Migration never adopts a remote author identity.

Migration compares old and new authoritative graphs with the exact classifier:
add, unequal-value edit, delete, invalidate, and validate. Representation-only,
identifier-only, validity-only, and `Unchanged` transitions are silent. It
scopes every emitted edit/invalidate/validate to the exact add generation of the
materialization whose value or freshness changed; an unresolved generation
rejects the migration. It reserves distinct local journal sequences after the
observed watermark and commits the new graph, immutable entries, and delivery
records atomically.
Aborted reservations may leave gaps and must never be reused.

Each migration delivery uses receiver-local append-or-replace: it deletes the
previous record named by `DeliveryHead[K,A]`, inserts the new self-contained
record above the cursor watermark, updates the head, and advances the watermark
in the graph installation batch. Migration preserves at most one retained
delivery record per key/action; preexisting and newly created gaps remain valid.
