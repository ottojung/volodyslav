# Journal during migration

A supported journal-preserving migration copies or preserves exactly:

```text
logical JournalEntry map
notification JournalRecord map
localJournalClock
localJournalRecordClock
journalRecordHighWatermark
cursorCoverageFrontier
local DatabaseFingerprint
```

It does not renumber records. A journal-silent migration leaves positions and
notification metadata unchanged. A migration changing notification-relevant
logical or materialized state follows the ordinary emission rule: its final
same-key record is after the pre-transition high-watermark. Graph, logical
entries, records, allocators, high-watermark and frontier commit atomically.

Restart and same-host self-restoration preserve supported cursor meaning. A
stable, serialized token decodes with the same authority after cutover. An older
checkpoint rollback under the same durable writer fingerprint remains
unsupported. A future incompatible persistent format is a rollout compatibility
problem, not ordinary cursor semantics.

Migration still preserves logical entry identity and causal semantics and does
not invoke computors. It does not update `modifiedAt` merely because bytes move.
The established closed classifier remains authoritative: identifier-only,
representation-only, timestamp-only and harmless validity-only differences are
silent. Any hard-invalidation transition requiring a barrier authors it and its
notification atomically; settled sufficient state is carried silently.
