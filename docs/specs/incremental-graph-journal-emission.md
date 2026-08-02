# IncrementalGraph Journal Emission

## Purpose

This document specifies when journal entries are created — the rules for `add`,
`edit`, `delete`, `invalidate`, and `validate` emissions triggered by
IncrementalGraph operations, migration, and synchronization.

Synchronization may emit `invalidate` and `delete`; it may also copy,
reposition, or omit existing events. See
`docs/specs/incremental-graph-journal-sync.md` for the exact pre/post
conditions.

Journal emission is always coordinated with the graph storage mutation that caused it: a journal entry MUST NOT be durably committed unless the corresponding graph change is also durably committed.

## Event origination

Ordinary graph operations and migration originate their required events
atomically with their transitions. Every ordinary graph or migration transition
covered by this specification must originate its journal event.

## Notification coverage

Journal coverage has no false negatives for supported graph changes, but may
contain conservative or duplicate notifications. The action of an entry records
the reason or category under which the notification was originated; it is not an
exact-once assertion and does not assert current graph state.

Synchronization may change graph state in ways that do not originate a new
event. Synchronization originates sync-derived events only for the symmetric
predicates defined in `docs/specs/incremental-graph-journal-sync.md`:

```
F(K) is unmaterialized and at least one source materializes K
    => SyncDeleteJournalEntry
F(K) is potentially-outdated and at least one source is up-to-date
    => SyncInvalidateJournalEntry
```

Other synchronization-induced graph changes MUST be covered by repositioning
an existing event. See `docs/specs/incremental-graph-journal-sync.md` for the
`notificationCarrier(K)` rule.

## Terminology

Use the following terms consistently:

- **originate an event**: create a new logical event for an actual transition
  or a sync-derived merge fact.
- **preserve an event**: retain an existing event without changing its physical
  position.
- **reposition an event**: move an existing event to a new physical position
  for notification, preserving its original action, time, creator, and eventId.
- **provide notification coverage**: ensure that every key requiring notification
  has a carrier after the relevant watermarks, whether by origination or
  repositioning.

---

## Freshness emission invariant

Every ordinary graph or migration operation that transitions an existing
materialized node from `up-to-date` to `potentially-outdated` emits
`invalidate`. Every successful graph recomputation that transitions an already
materialized node from `potentially-outdated` to `up-to-date` emits `validate`.

Synchronization may emit `invalidate` and `delete` under the conditions
specified in `docs/specs/incremental-graph-journal-sync.md`. When no
sync-derived event applies, synchronization uses notification-aware
repositioning of an existing canonical event instead.

---

## Emission triggers

### First materialization: `add`

REQ-JE-01: When a node becomes materialized for the first time (i.e., a new `NodeIdentifier` is allocated and the node's value is written to storage), the system MUST emit an `AddJournalEntry` (`action: "add"`, `creator: Hostname`).

First materialization occurs during:

- A `pull(nodeName, bindings)` call for a previously unmaterialized node.
- A migration `storage.create(nodeKey, value)` call that allocates a fresh `NodeIdentifier`.

REQ-JE-02: The `add` entry MUST be emitted in the same durable transaction as the node's identifier allocation, value write, and identifier-lookup insertion. If any part of that transaction fails, the journal entry MUST NOT be committed.

### Value change: `edit`

REQ-JE-03: When a node's stored value changes materially (i.e., the new computed value is not `isEqual` to the old stored value), the system MUST emit an `EditJournalEntry` (`action: "edit"`, `creator: Hostname`).

REQ-JE-04: The `edit` entry MUST be emitted in the same durable transaction as the value write and counter increment.

#### Unchanged recomputation

REQ-JE-05: If a recomputation returns a value that is `isEqual` to the existing stored value, the system MUST NOT emit an `edit` entry. This includes cases where the computor explicitly returns the `Unchanged` sentinel and cases where the computor returns a value that happens to be deeply equal to the old value. However, if the node was `potentially-outdated` and transitions to `up-to-date`, the system MUST emit a `validate` entry.

#### Cache hit

REQ-JE-06: If a `pull` encounters an up-to-date node and returns its stored value without invoking the computor, the system MUST NOT emit a journal entry.

### Freshness transition: `invalidate`

REQ-JE-07: When a host-local graph or migration transition changes a node's
freshness from `up-to-date` to `potentially-outdated`, the system MUST emit a
`HostInvalidateJournalEntry` (`action: "invalidate"`, `creator: Hostname`).
This transition may occur through:

- An explicit `invalidate(nodeName, bindings)` call.
- Cascading invalidation from an invalidated dependency.
- Migration `storage.invalidate` (see `incremental-graph-journal-migrations.md`).
- Any other host-local path that transitions a node's freshness from
  `up-to-date` to `potentially-outdated`.

Synchronization is NOT a trigger for REQ-JE-07. Synchronization invalidation is
governed exclusively by the symmetric predicate in
`incremental-graph-journal-sync.md` and originates a
`SyncInvalidateJournalEntry` (`creator: Sync`), never a
`HostInvalidateJournalEntry`.

REQ-JE-07a: The `invalidate` entry MUST be emitted in the same durable transaction as the freshness state change.

REQ-JE-07b: An `invalidate` entry is NOT a value change — it signals that the node's freshness has been downgraded. The node's stored value and `NodeIdentifier` are unchanged by this entry alone.

### Freshness transition: `validate`

REQ-JE-07c: When successful graph recomputation makes an already materialized
node `up-to-date` from `potentially-outdated`, the system MUST emit a
`ValidateJournalEntry` (`action: "validate"`, `creator: Hostname`). The
transition may occur through:

- A `pull(nodeName, bindings)` that recomputes a node and returns an unchanged
  value (recalculating does not change the value, but the freshness transition
  from `potentially-outdated` to `up-to-date` is a real event).
- A `pull(nodeName, bindings)` that recomputes a node and returns a changed
  value: this emits both an `edit` and a `validate` (see below for the
  ordering).
- Explicit validation paths that transition a node from `potentially-outdated`
  to `up-to-date` outside the ordinary pull path.

REQ-JE-07d: A `validate` entry is NOT by itself a value change — it signals
that an already materialized node's freshness has been restored from
`potentially-outdated` to `up-to-date`. The `NodeIdentifier` is unchanged.

REQ-JE-07e: The `validate` entry MUST be emitted in the same durable transaction as the freshness state change.

REQ-JE-07f: When a recomputation changes a node's value, the system emits, in this order:

```
edit
validate
```

Both entries are committed in the same durable transaction as the new value, counter updates, and the freshness transition. Their indices are contiguous, with `edit` receiving the lower index and `validate` the higher index.

REQ-JE-07g: When a recomputation returns an unchanged value but the node was `potentially-outdated`, the system emits only `validate`. No `edit` is emitted.

REQ-JE-07h: When a `pull` encounters an up-to-date node (cache hit), the system MUST NOT emit `validate`. No freshness transition occurred.

REQ-JE-07i: When a node is materialized for the first time, the system emits only `add`. No `validate` is emitted because first materialization is not a transition from `potentially-outdated` to `up-to-date`.

REQ-JE-07j: Repeating an operation that leaves freshness unchanged emits nothing:
- `potentially-outdated → potentially-outdated`: emit nothing
- `up-to-date → up-to-date`: emit nothing

#### Concurrent invalidations

Two invalidations may begin while a node is up-to-date and both may prepare and
commit an `invalidate` entry. This is allowed even though, viewed as state
transitions, the pair is equivalent to a single invalidation.

```
initially: N is up-to-date

invalidate A observes N as up-to-date
invalidate B observes N as up-to-date

A commits invalidate(N)
B commits invalidate(N)
```

The journal may contain two `invalidate` entries.

This is safe because:

- invalidations use compatible daytime activity;
- pulls and recomputations use incompatible nighttime activity;
- migration and structural synchronization use holiday activity;
- therefore `add`, `edit`, or `validate` cannot interleave between those
  concurrent invalidations;
- both entries are notifications for the same key;
- logical journal compaction retains only the latest freshness-category entry
  for `N`.

REQ-JE-07k: The implementation MUST NOT add commit-time freshness
deduplication to suppress the concurrent-invalidation duplicate case.

A sequential invalidation that begins after the node is already stale may still
emit nothing, as specified by REQ-JE-07j. The duplicate allowance covers
duplicates caused by overlapping operations and conservative notification
behavior.

### Deletion: `delete`

REQ-JE-08: A `delete` journal entry has two concrete variants. The
`HostDeleteJournalEntry` represents an actual host-local deletion. The
`SyncDeleteJournalEntry` records that at least one synchronized source
materialized the key while the merged result does not. The following operations
produce `delete` entries:

- **Actual deletion operations**: `storage.delete` and any future graph deletion
  operation emit a `HostDeleteJournalEntry` for the node they delete.
- **Synchronization**: Synchronization originates a `SyncDeleteJournalEntry`
  when the merged result does not materialize a key that at least one source
  materialized. See `incremental-graph-journal-sync.md`.

REQ-JE-09: Ordinary graph operations (`pull`, `invalidate`, recomputation) MUST NOT emit `delete` entries unless and until the IncrementalGraph system implements a general node deletion API. This specification does not assume such an API exists.

REQ-JE-10: Migration `storage.delete` MUST emit a `delete` journal entry for the deleted node. See `incremental-graph-journal-migrations.md` for the migration-specific rules.

### Migration actions

Migration actions have their own journal-emission rules, specified fully in `incremental-graph-journal-migrations.md`. In summary:

- `storage.create` produces an `add` journal entry.
- `storage.keep` produces no journal entry.
- `storage.override` produces no journal entry. It is a semantic-preserving representation rewrite that inherits freshness from the old record and does not propagate invalidation.
- `storage.delete` emits a `delete` journal entry for the deleted node (but does not remove older journal entries—see `incremental-graph-journal-migrations.md`).
- `storage.invalidate` preserves the stored value and emits `invalidate` only
  for `up-to-date → potentially-outdated`. An already stale node remains
  unchanged and emits nothing.

---

## Coordination with graph writes

REQ-JE-11: A journal entry MUST be written to durable storage in the same LevelDB batch as the graph-state writes it is associated with. A failed batch flush MUST leave both the graph state and the journal state unchanged.

REQ-JE-12: A successful batch flush MUST result in the journal entry being durably committed and the `last_journal_index` watermark being advanced (if the entry received a new index).

REQ-JE-13: The volatile journal state (in-memory next-index counter) MUST be updated only after the durable batch flush succeeds. This follows the established "disk before memory" invariant (see `docs/specs/incremental-graph-volatile-consistency.md`).

---

## HostStateVersion advance

One successful host-originated durable transaction advances `HostStateVersion`
exactly once. A transaction may originate several journal entries (for example
`edit` followed by `validate`) but advances the version only once for the
complete atomic state transition. The version, the graph mutations, the journal
entries, the indices, the host event IDs, and the watermark are committed in
one atomic durable batch during darkroom finalization (see
`incremental-graph-journal-types.md` § Durable commit rules).

REQ-JE-20: During darkroom finalization, the implementation MUST read the
currently committed `HostStateVersion`, allocate its unique successor, and add
that successor to the same durable batch as the graph mutations, the merge-basis
candidate/evidence mutations (see `incremental-graph-journal-types.md` §
Merge-basis maintenance), the journal entries, indices, event IDs, and
watermark. Volatile next-version state is published only after the durable
commit succeeds.

REQ-JE-21: A failed batch MUST leave graph state, the merge basis, journal
state, `last_journal_index`, `HostStateVersion`, and volatile next-version
state all unchanged.

REQ-JE-22: No-op operations MUST NOT advance the version or mutate the merge
basis: cache-hit pull, repeated invalidation of an already stale node, failed
recomputation, failed transaction, export, compaction, synchronization-only
changes, and replica reopening or switching.

REQ-JE-23: Concurrent host-originated transactions MUST serialize version
allocation through the same finalization discipline, so they cannot receive the
same successor or publish changes out of version order. This makes the
following failures impossible: new graph or journal state becomes durable while
the exported causal frontier still advertises the old host version; new graph
state is published with a stale merge basis; and new merge-basis evidence is
published with an old graph or frontier coordinate.

---

## Transition-to-event matrix

This document is the single authoritative owner of the transition-to-event
matrix. Ordinary pull, invalidation, migration, bulk reset, and future
host-local graph deletion all reference this matrix instead of restating
variants.

For each semantic node key, compute the complete delta between the previously
installed state and the newly published state, then emit events:

```text
current unmaterialized, target materialized                -> add
current materialized,   target unmaterialized              -> delete
both materialized,      semantic value changed             -> edit
both materialized,      up-to-date -> potentially-outdated -> invalidate
both materialized,      potentially-outdated -> up-to-date -> validate
both materialized,      identifier or representation changed only -> no event
```

When more than one condition applies:

- value change plus freshness restoration: `edit`, then `validate`;
- value change plus freshness downgrade: `edit`, then `invalidate`;
- first materialization: `add` only, regardless of initial freshness;
- deletion: `delete` only.

`validate` is generalized from "successful recomputation only" to a
host-originated transition that establishes an already materialized node as
`up-to-date` with complete valid dependency proofs. This includes a validated
bulk graph replacement (`replaceGraphState`, see
`incremental-graph-synchronization.md` § 17 Reset as a bulk graph operation)
that restores freshness with complete proofs.

There are no reset-specific journal actions or event variants; reset emits only
the ordinary actions above.

## Bulk reset

Reset is an ordinary bulk graph transaction. The core graph operation
(`replaceGraphState`) must not receive or install a target snapshot's journal,
watermark, cursor state, or journal provenance; the journal records the reset's
graph changes through the transition-to-event matrix above.

Atomicity and ordering:

- The entire operation is published atomically from the perspective of graph and
  journal readers.
- If the destination is built in an inactive replica: copy the existing journal
  prefix and watermark unchanged; build the new graph state; append
  reset-generated journal entries at fresh indices above the old watermark;
  persist the one successor `HostStateVersion`; switch only after the complete
  destination is durable and validated.
- Use one deterministic entry order:
  1. deletes in reverse dependency-topological order;
  2. adds and edits in dependency-topological order;
  3. invalidations in dependency-topological order;
  4. validations in dependency-topological order;
  5. break unrelated ties by canonical `NodeKey` ordering;
  6. for one key, place its state event before its freshness event.

A successful changed reset advances the local `HostStateVersion` exactly once,
regardless of how many nodes and journal entries it changes. A no-op reset emits
no journal entries, advances no watermark and no host version, and performs no
replica switch. A failed reset leaves graph state, journal state, watermark,
host version, active replica, and existing cursor validity unchanged.

Reset must preserve every established journal position and absence, append only
above the current watermark, never decrease `last_journal_index`, preserve the
existing `JournalCursorDomain`, keep existing `PossibleNodeChange` cursors
valid, and preserve the local `HostInstanceId`. It is not journal compaction,
synchronization normalization, migration, or journal replacement.

A reset deletion must produce the same durable deletion evidence as any other
host-local deletion (an ordered tombstone candidate in the merge basis and a
`delete` journal event), never be represented merely by absence.

---

## Journal index allocation

JournalIndex allocation MUST happen during darkroom finalization, atomically with the durable batch commit. This ensures the published-prefix invariant (REQ-JT-17 through REQ-JT-18): once `last_journal_index = H` is published, no later ordinary append can ever fill, replace, or change a position at or below `H`.

REQ-JE-14: Each emitted journal entry MUST be assigned a unique, monotonically increasing `JournalIndex` during darkroom finalization, as part of the atomic durable batch that commits both the entry and the watermark. The index MUST be allocated strictly above the previously committed watermark. This mirrors the `NodeIdentifier` allocation pattern (see `docs/specs/incremental-graph-last-node-index.md`), with the critical difference that allocation is deferred until the commit point rather than being consumed at transaction start.

REQ-JE-15: A transaction MUST prepare unindexed journal entries during its unlocked body. Only once the transaction enters darkroom does it allocate a fresh contiguous range strictly above the current committed watermark, add those indexed entries and the new watermark to the same batch, and commit them atomically. This prevents the trace where one transaction allocates an index, a later transaction commits at a higher index and publishes the watermark, and the original transaction later fills a gap below the published watermark.

REQ-JE-16: Gaps in the journal index sequence are acceptable. They may be caused by:
- Compaction removing entries (logical-view pruning).
- The synchronization-normalization phase: same-index poisoning,
  established-absence propagation, logical-view pruning, duplicate occurrence
  normalization, or carrier repositioning (see
  `incremental-graph-journal-sync.md` § Synchronization normalization).

Gaps caused by failed transactions are NOT possible under this allocation model, because index allocation occurs only during the durable commit, which either succeeds or fails atomically.

REQ-JE-17: The `last_journal_index` stored in `rendered/r/global/last_journal_index` is updated to the committed journal entry's index as part of the same atomic durable batch.

### JournalEventId assignment during first commit

REQ-JE-18: During darkroom finalization, after assigning an ordinary host event
its initial `JournalIndex` `i`, the implementation MUST compute the event's
`JournalEventId` as:

```
const eventId = JSON.stringify([
    "host",
    hostnameToString(entry.creator),
    hostInstanceIdToString(instanceId),
    journalIndexToNumber(i),
]);
```

`instanceId` is the storage-instance identity active in the current storage
instance. The entry, `eventId`, physical index `i`, graph mutation, merge-basis
candidate and evidence mutations, and final watermark MUST be committed in the
same atomic durable batch. Sync-derived events are not assigned an ID from the
physical index; their `eventId` derives from the merge protocol version, the
action, the key, and the canonical derived time of the joined journal evidence
(see `incremental-graph-journal-sync.md`).

REQ-JE-19: For an existing event being replicated or reappended (not newly created), the implementation MUST NOT assign a new event ID. It MUST preserve the original `eventId` string unchanged. Only the physical storage position changes.

---

## Testing properties

The following properties MUST hold for a conforming implementation:

### P1 — Add on first pull

Pulling a previously unmaterialized node produces a journal entry with `action: "add"` and a `time` within the execution window of the pull.

### P2 — Edit on value change

Pulling a previously materialized node whose computor returns a different value (not `isEqual` to the old value) produces a journal entry with `action: "edit"`.

### P3 — No edit on unchanged; validate emitted when freshness transitions

Pulling a node whose computor returns `Unchanged` or a deeply-equal value produces no `edit` entry. If the node was `potentially-outdated` before recomputation and becomes `up-to-date`, the system emits a `validate` entry for the freshness transition.

### P4 — No entry on cache hit

Pulling an up-to-date node (cache hit) produces no new journal entry.

### P5 — Entry on freshness transition (invalidate)

Transitioning a node's freshness from `up-to-date` to `potentially-outdated` produces a journal entry with `action: "invalidate"`.

### P5a — Entry on freshness transition (validate)

Successful recomputation that transitions an already materialized node from
`potentially-outdated` to `up-to-date` produces a journal entry with
`action: "validate"`. This occurs when:
- An unchanged recomputation returns the existing value (only `validate` emitted).
- A changed recomputation emits `edit` and `validate` in that order (contiguous indices).
- A cache hit emits nothing (no freshness transition occurred).
- First materialization emits only `add` (first materialization is not a transition from `potentially-outdated`).

### P6 — Origin atomicity

When a logical event is first originated, the event and its associated
transition or merge fact are durably committed atomically. A failed origin
transaction leaves neither the event nor the associated change committed.

Later graph changes, synchronization, and compaction may change current graph
state or remove or reposition physical event occurrences without invalidating
that atomicity guarantee.

### P7 — Monotonic last_journal_index

After a sequence of journal-emitting operations, `last_journal_index` must be non-decreasing and must accurately reflect the greatest committed journal index.

### P8 — Failed transaction creates no gap

A failed journal-emitting transaction:
- publishes no entry;
- advances no watermark;
- consumes no journal index;
- creates no gap.

If a transaction prepares an unindexed entry, but then fails during darkroom finalization (or before), no trace of the failed entry remains in the journal index sequence.

### P9 — Host-originated event identity

A new ordinary or migration host-originated entry assigned initial position
`7` in the current storage instance receives:

```
eventId = JSON.stringify(["host", hostnameToString(host),
                          hostInstanceIdToString(I), 7])
```

This applies to `AddJournalEntry`, `EditJournalEntry`,
`HostDeleteJournalEntry`, `HostInvalidateJournalEntry`, and
`ValidateJournalEntry`. The entry, event ID, graph mutation, journal position,
and watermark commit atomically. A reader that sees the entry at index 7 also
sees its complete `eventId`. A reader that does not see index 7 sees no part of
the event.

### P9a — Sync-derived event identity

A `SyncDeleteJournalEntry` or `SyncInvalidateJournalEntry` derives its event ID
from the merge protocol version, the action, the key, and the canonical derived
time of the joined journal evidence, never from the two immediate source
snapshots (see `incremental-graph-journal-sync.md`). The ID is
independent of the destination physical journal index and exists conceptually
before fresh physical placement. The sync event, the destination graph records
associated with the merge result, the physical journal position, and the
destination watermark must be durably consistent before cutover.

### P10 — Replication preserves event ID

An event reappended or replicated to another host retains its original `eventId` string unchanged. The `eventId` remains the same across all copies, even though the physical storage index differs.

### P11 — Duplicate concurrent invalidations

Two invalidations that begin while node `N` is `up-to-date` may both commit an
`invalidate` entry. The journal may contain two `invalidate` entries for `N`.
Logical compaction still returns at most one freshness-category entry for `N`,
and the implementation performs no commit-time freshness deduplication.

### V1 — Successful changed pull: one version advance

A pull that recomputes a node and changes its value commits graph mutation,
`edit` (and `validate`) journal entries, the new watermark, and one successor
`HostStateVersion` in the same atomic batch. The exported causal frontier
advertises exactly the successor version, never the old version with the new
state.

### V2 — Changed recomputation emitting edit and validate: one version advance

A recomputation that changes a value emits `edit` then `validate` (two journal
entries) but advances `HostStateVersion` exactly once for the complete atomic
state transition.

### V3 — Unchanged recomputation emitting only validate: one version advance

A recomputation that returns an unchanged value for a `potentially-outdated`
node emits only `validate` and advances `HostStateVersion` exactly once (the
freshness transition to `up-to-date` is host-originated state).

### V4 — Cache hit: no advance

A pull that encounters an up-to-date node emits no journal entry and advances
no version.

### V5 — Two concurrent invalidations: distinct successive versions

Two overlapping invalidations of the same node commit two `invalidate` entries
in two transactions; version allocation is serialized through the same
finalization discipline, so the two transactions receive two distinct successive
versions.

### V6 — Failed transaction before durable flush: no advance

A transaction that fails before the durable batch commits leaves graph state,
journal state, `last_journal_index`, `HostStateVersion`, and volatile
next-version state unchanged.

### V7 — Crash cannot expose new graph state under an old coordinate

Because the graph mutations, journal entries, watermark, and the successor
version commit in one atomic durable batch, a crash can never leave new graph
or journal state durable while the exported causal frontier still advertises
the old host version.

### V8 — Successful state-changing migration: one cutover advance

A successful migration that produces host-originated synchronization-relevant
state derives the successor version from the previously active replica,
persists it in the completed inactive destination, and publishes it only
through successful active-replica cutover. Migration-generated `add`, `delete`,
and `invalidate` entries belong to that one migration version advance.

### V9 — Failed migration: no advance

A failed migration preserves the previously active coordinate; the destination
is discarded or rebuilt and never publishes a version.

### V10 — Fresh initialization starts at version 0

A freshly initialized storage instance begins at `HostStateVersion = 0`. A
successful changed reset advances the same instance's version exactly once as
one bulk transaction; the `HostInstanceId` does not change.

### R1 — Reset to identical graph is a complete no-op

If the target graph projection equals the installed graph, `replaceGraphState`
emits no journal entries, advances no watermark and no host version, and
performs no replica switch.

### R2 — Target contains a new node: append `add`

A target key that is unmaterialized in the installed graph and materialized in
the target emits one `AddJournalEntry`.

### R3 — Target lacks an existing node: append `delete`

A key materialized in the installed graph and unmaterialized in the target emits
one `HostDeleteJournalEntry` and creates the durable deletion tombstone evidence.

### R4 — Target has a changed value: append `edit`

A key materialized in both states with a changed semantic value emits one
`EditJournalEntry`.

### R5 — Up-to-date to stale: append `invalidate`

A key that is `up-to-date` in the installed graph and `potentially-outdated` in
the target emits one `HostInvalidateJournalEntry`.

### R6 — Stale to up-to-date with valid proofs: append `validate`

A key that is `potentially-outdated` in the installed graph and `up-to-date`
with complete valid dependency proofs in the target emits one
`ValidateJournalEntry`.

### R7 — Value change plus freshness restoration: append `edit`, then `validate`

A key whose value changed and whose freshness is restored to `up-to-date` emits
`edit` at the lower index and `validate` at the higher index.

### R8 — Mixed large reset: deterministic ordering and one version advance

A large reset with deletes, adds, edits, invalidations, and validations emits
all entries in the deterministic order defined in § Bulk reset (deletes in
reverse dependency-topological order, adds/edits in dependency-topological
order, invalidations and validations in dependency-topological order, ties by
canonical `NodeKey`, state event before freshness event per key), and advances
`HostStateVersion` exactly once for the whole operation.

### R9 — Failed construction or validation: no observable change

If the target graph fails validation or the destination cannot be completed, no
journal entry, watermark advance, version advance, or replica switch is
published.

### R10 — Crash before cutover: old graph and journal remain active

A crash before the active-replica cutover leaves the previously active graph and
journal in place; the incomplete destination is discarded.

### R11 — Existing cursor remains valid and observes reset events

A `PossibleNodeChange` cursor obtained before reset remains valid after reset;
its next query observes the reset-generated events appended above the previous
watermark.

### R12 — Watermark remains monotonic

Reset never decreases `last_journal_index`; reset-generated entries are
appended at strictly increasing fresh indices.

### R13 — Reset does not change `HostInstanceId`

The local `HostInstanceId` is unchanged by reset; host event identity and
frontier coordinates continue to use it.

### R14 — A later synchronization propagates the reset as an ordinary newer contribution

After a changed reset advances the local `HostStateVersion`, a later
synchronization exports the new state as an ordinary newer host contribution;
the reset's graph changes propagate through the normal merge basis.

### R15 — Repeating the same reset after it succeeded is a no-op

Applying the same target graph projection again after a successful reset emits
no journal entries and advances no version.
