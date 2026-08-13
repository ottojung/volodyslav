# Journal during migration

This specification applies only after the journal subsystem exists. It does not
describe upgrading a pre-journal database; that remains outside the
[rollout scope](../incremental-graph-journal.md#implementationrollout-scope).

Migration builds authoritative graph state from one fixed receiver snapshot and
preserves exactly:

```text
durable DatabaseFingerprint
logical JournalEntry collection
notification JournalRecord collection
localJournalClock
localJournalRecordClock
journalRecordHighWatermark
cursorCoverageFrontier
local Ed25519 private signing key and public verification-key registry
```

It does not renumber records or change immutable contents. Before cutover it
checks generation and retained causal-reference resolution, identity and
ordering; logical-clock and record-clock coverage; unique immutable content per
`JournalEntryId` and `JournalIndex`; high-watermark coverage; monotone frontier;
and consistent issuer verification keys. It MAY additionally diagnose visible
immutable-ID conflicts or validation-context regression. Compaction may have
legitimately removed historical evidence, so these checks do not promise
complete diagnosis beyond the supported-state boundary.

A supported migration MUST accept structurally valid uncompacted history.
Non-canonical representation is not corruption and cutover does not require
either journal to equal its compact form. Migration never runs implicit logical
or notification compaction and a journal-silent migration preserves all entries,
records, coordinates, allocators, watermark, frontier, and token authority.
Independent maintenance compaction remains a separate operation.

For example, several superseded logical entries and notification occurrences may
be copied and cut over unchanged. Supported process restart and same-host
self-restoration likewise preserve encoded cursor validity. Rollback to an older
checkpoint under the same durable writer identity remains unsupported.

Migration applies the exact closed classifier. `create` authors add with
`add.time=toUnixTimestamp(createdAt)=toUnixTimestamp(modifiedAt)`; delete and
genuine freshness changes author their ordinary actions. `keep`, ordinary
`invalidate`, and semantic-preserving `override` create no value event and
preserve `modifiedAt`; representation-, identifier-, timestamp-, and harmless
validity-only changes are silent. `Unchanged` is silent. Every authored logical
entry uses the host logical clock and atomically appends its `(key,time)` record.
Any notification-relevant changed key not already covered by such a record gets
one final-state record after the pre-migration high-watermark. Aborted inactive
construction exposes no committed allocator advancement; reserved gaps are
harmless and sequences are never reused after publication.

The closed classifier is not sufficient when migration hardens an already-stale
cache. Whenever `keep` or `override` discards incoming proofs, explicit migration
`invalidate()` removes or reasserts them, or
`create(...,"potentially-outdated")` establishes a must-recompute
materialization, migration authors an ordinary generation-scoped invalidate
unless that same decision already produced the exact barrier. It uses the
existing generation (or new add generation), is allocated above all observed
logical history, participates normally in `invalidateFrontier`, and commits with
graph/proof state and its notification record. There is no migration action.

A node already hard-invalidated with absent incoming proofs and an outstanding
barrier may be carried silently when migration makes no new proof-removal or
hardening decision. Repeating passive `keep` or `override` authors nothing and
advances neither allocator. Explicit `invalidate()` is a deliberate reassertion
and MUST author a fresh barrier and record even from settled state.

Graph, logical entries, notification records, allocators, high-watermark,
frontier, and token-key metadata required by a migration commit atomically.
Migration never seeds graph authority from notification records and never invokes
computors. Logical compaction treats migration entries identically; notification
compaction treats their records identically.
