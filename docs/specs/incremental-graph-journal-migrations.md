# Journal during migration

Migration builds authoritative graph state independently, starting from one
fixed receiver snapshot containing:

```text
durable HostFingerprint
StoredJournalEntry collection
localJournalClock
localJournalIndexWatermark
```

It copies every retained entry and its receiver-local index exactly, then
validates immutable ID content, generation and validation-causal references,
same-author validation-context monotonicity, canonical compaction,
logical clock coverage, unique indexes, and index-watermark coverage. It never
imports another host's index or author ownership.

Migration applies the exact closed classifier. New logical entries use the host
clock, required generation, action-specific logical time, and distinct fresh
local indexes. Any changed key without a newly indexed entry touches its greatest
retained witness. Graph, entries, touches, and watermarks commit atomically.
`Unchanged`, representation-only, identifier-only, and validity-only changes are
silent. Aborted inactive construction exposes no index advancement and index
values are never reused after publication.
