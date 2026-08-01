# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how journal state is reconciled after graph
synchronization has independently produced its final merged graph.

Graph synchronization is fully specified by
`docs/specs/incremental-graph-synchronization.md` and does not inspect or depend
on journal state. Journal reconciliation runs downstream from the completed
graph merge.

Journal reconciliation is pairwise commutative: given two exact source
snapshots `A` and `B`, it must derive the same result from `merge(A, B)` and
`merge(B, A)`. The result must not depend on which source is called local,
host, keep, take, current, or remote.

---

## Input model

```
A = exact pre-merge source graph A, with its established journal A
B = exact pre-merge source graph B, with its established journal B
F = final graph produced deterministically and commutatively by graph
    synchronization from A and B

aH = A.last_journal_index
bH = B.last_journal_index
P  = max(aH, bH)
```

Each source snapshot is staged from an exact revision/checkpoint and carries a
`SourceRevisionId` (see `incremental-graph-journal-types.md`).

Graph synchronization produces `F` and the symmetric journal synchronization
delta `SyncDelta` defined below. Journal reconciliation receives `A`, `B`, `F`,
`SyncDelta`, and the two source journals. It must not inspect or compare
`ComputedValue`s itself.

### Symmetric notification delta

Define `observableState` and `equalObservableState` as in
`docs/specs/incremental-graph-synchronization.md` § GraphDelta. Then:

```
SyncDelta = {
    K |
    !equalObservableState(A(K), F(K))
    ||
    !equalObservableState(B(K), F(K))
}
```

A key is in `SyncDelta` whenever installing `F` changes its public observable
state relative to either source. This ensures that journal consumers following
either source receive notification coverage.

Consequences:

- materialized in A and unmaterialized in F: included
- materialized in B and unmaterialized in F: included
- up-to-date in A and potentially-outdated in F: included
- up-to-date in B and potentially-outdated in F: included
- semantic value change relative to either source: included
- identifier-only replacement with equal value and equal freshness: excluded
- metadata-only or validity-only change: excluded
- no observable change in either source: excluded

The definition is symmetric and normative; it does not depend on which source
is locally active.

---

## Graph/journal separation

- Journal actions record the reason or category under which a notification was
  originated. They are not exact-once assertions.
- A retained journal event does not assert current graph state.
- It is valid for the latest retained journal event to describe an older state
  than the current final graph.
- Consumers must always re-read current graph state.

---

## Conceptual reconciliation order

Journal reconciliation follows this conceptual order. Stages that involve
durable storage use the structural synchronization protocol described below.

### 1. Graph synchronization determines F and SyncDelta

Graph synchronization independently produces the final merged graph `F`,
commutatively and independently of source naming. Journal reconciliation does
not participate in graph planning.

### 2. Validate event identity across both committed prefixes

Event-ID integrity is checked over the union of established occurrences from
both sources:

```
A positions 1 .. aH
union
B positions 1 .. bH
```

If one `eventId` appears once in A and once in B, those two occurrences MUST
have identical immutable journal payloads. The same `eventId` MUST identify the
same immutable payload regardless of which source an occurrence resides in.
Copies may occupy different physical positions.

Positions greater than a source's `last_journal_index` are not established
journal history and MUST NOT participate in identity validation, logical-view
construction, conflict resolution, or physical reconciliation.

A payload disagreement for one `eventId` within the validated union is a
journal-integrity error: synchronization aborts, does not switch replicas,
leaves the previously active replica unchanged, and neither poisons the
occurrences nor chooses a payload.

The journal payload includes action, key, identifier, time, and creator. It does
not include any `ComputedValue`.

### 3. Compute each source logical journal view

For each source, compute:

```
logicalJournalView(sourceJournal, sourceH)
```

where `sourceH` is that source's `last_journal_index`. Storage above `sourceH`
is outside the committed prefix and is excluded from the logical view.

For each semantic key this produces at most one source state entry and one
source freshness entry.

### 4. Select retained historical journal evidence

Canonical journal events are the events retained in the final journal for each
semantic key. They are canonical only for journal retention and notification.
Selection uses journal-only rules: it does not consult graph state, graph
identifiers, or graph freshness.

#### Canonical state event

For each semantic key:

- if neither source has a state entry, the destination has none;
- if only one source has a state entry, that existing event is canonical;
- if both have state entries, compare later `time`, then (when identifiers
  differ and times tie) lexicographically greater `NodeIdentifier`, then (when
  identifiers and times tie) lexicographically greater `eventId`.

The winning existing event is canonical. It is retained in the final journal
as historical notification evidence.

#### Canonical freshness event

For each semantic key, compare source freshness events directly. Do not filter
by canonical state identifier, final graph identifier, current materialization,
or current graph freshness.

- if neither source has a freshness entry, the canonical freshness event is
  absent;
- if only one source has a freshness entry, that existing event is canonical;
- if both have freshness entries, compare by later `time`, then lexicographically
  greater `eventId` on a tie.

The winner is the canonical freshness event. It is historical journal evidence
only: it does not determine final graph freshness or assert current graph state.
The retained freshness event may refer to an older identifier than the retained
state event.

### 5. Generate sync-derived events symmetrically

Synchronization may newly originate only sync-derived events with action
`invalidate` or `delete`. It never originates `add`, `edit`, or `validate`.
All predicates below are independent of source ordering.

#### Generated `delete`

Generate one sync-derived `delete` for semantic key `K` exactly when:

```
F(K) is unmaterialized
and
at least one of A(K) or B(K) is materialized
```

This predicate is independent of source ordering.

The event's node identifier is selected symmetrically:

- if only one source materializes `K`, use that source's identifier for `K`;
- if both sources materialize `K`, choose the identifier belonging to the
  deterministic winning source materialization according to the symmetric
  materialization comparison tuple `(modifiedAt, NodeIdentifier,
  sourceFingerprint)` from `docs/specs/incremental-graph-synchronization.md`
  REQ-SYNC-07;
- never choose an identifier because it belongs to the source currently called
  local.

Use:

```
event.action = "delete"
event.key   = K
event.id    = identifier selected above
```

A generated `delete` claims:

```
At least one synchronized source materialized K, while the deterministic
merged result does not materialize K.
```

It does not claim that every participating host locally experienced a deletion.

#### Generated `invalidate`

Generate one sync-derived `invalidate` for semantic key `K` exactly when:

```
F(K) is materialized and potentially-outdated
and
at least one of A(K) or B(K) is materialized and up-to-date
```

This predicate is independent of source ordering.

Use:

```
event.action = "invalidate"
event.key   = K
event.id    = final materialization identifier of K in F
```

A generated `invalidate` claims:

```
At least one synchronized source considered K up-to-date, while the
deterministic merged result retains K as potentially-outdated.
```

It does not claim that every participating host locally experienced an
invalidation.

#### Delete dominates invalidate

When the generated-delete predicate applies, generate only `delete`. Do not
generate `invalidate` before deletion.

#### FreshPlacementSet

Synchronization maintains a conceptual `FreshPlacementSet` of complete immutable
events awaiting index allocation. Each member is identified by its `eventId`.

```
eventId
```

Because a sync-derived event's `eventId` is determined by the exact source
revisions, the action, and the key, the generated identity is stable across both
merge directions and across hosts. An existing event that is already a
sync-derived event from the same source revisions shares that `eventId`.

Define one operation:

```
enqueueFresh(event)
```

which is idempotent by `eventId`: calling `enqueueFresh` twice with the same
`eventId` has the same effect as calling it once.

All placement requests from:

- generated-event creation (below);
- loss of every surviving canonical occurrence (step 8);
- notification-bound enforcement (step 9);

must call this same operation.

#### Sync-derived event assignment

Every generated event begins unpositioned. It is enqueued via
`enqueueFresh(event)` for placement above `P = max(aH, bH)`.

Assign:

```
action   = "invalidate" or "delete"
key      = K
id       = as specified above
time     = deterministic sync event time (see below)
creator  = Sync{A, B}
```

`Sync{A, B}` is the nominal set of the two participating source hostnames,
canonically ordered (see `incremental-graph-journal-types.md`). The creator
describes the hosts whose exact source snapshots participated in deriving the
event; it does not identify one host as the actor.

After the source revisions, action, and key are fixed, assign the sync event
ID:

```js
JSON.stringify([
    "sync",
    canonicalSourceRevisions.map(({ hostname, revision }) => [
        hostnameToString(hostname),
        sourceRevisionIdToString(revision),
    ]),
    action,
    nodeKeyToString(key),
])
```

No special sync event type or alternate ID format.

#### Deterministic sync-event time

A sync-derived event must not use the wall clock of the host executing
reconciliation. Otherwise two hosts independently reconciling the same
snapshots at different times would produce different immutable payloads for the
same logical event.

The `time` is derived deterministically from source journal evidence for the
semantic key:

```
syncEvent.time =
    maximum time among the canonical source journal events for K
    participating in reconciliation
```

Include both the canonical state event and the canonical freshness event for
`K` when they exist (step 4).

A generated sync event is only valid when sufficient source journal evidence
exists. If graph state requires a generated event but no source journal evidence
exists for the materialized key, treat this as a journal-integrity error rather
than consulting the local wall clock.

#### Final canonical events

For each semantic key, the final canonical events are derived from the source
canonical events and any generated sync events:

```
finalCanonicalStateEvent(K)     = generated delete(K)    if one exists
                                = sourceCanonicalStateEvent(K)   otherwise
```

```
finalCanonicalFreshnessEvent(K) = generated invalidate(K)    if one exists
                                = sourceCanonicalFreshnessEvent(K)   otherwise
```

A key receiving a generated `delete` receives no generated `invalidate`:

```
finalCanonicalStateEvent(K)     = generated delete(K)
finalCanonicalFreshnessEvent(K) = sourceCanonicalFreshnessEvent(K) (when one exists)
```

The destination physically contains exactly:

- the final canonical state event for each semantic key, when one exists;
- the final canonical freshness event for each semantic key, when one exists.

"Final canonical" may mean either a retained or repositioned source event or a
newly generated sync event. The resulting physical journal equals its own
`logicalJournalView`.

### 6. Select notification carriers

Every key in `SyncDelta` must have a notification carrier positioned strictly
after `P` so that process cursors observing either source notice the change.

#### notificationCarrier(K)

For each `K` in `SyncDelta`, select exactly one carrier in this order:

1. the generated `delete` or `invalidate`, when one exists;
2. otherwise the final canonical state event;
3. otherwise the final canonical freshness event;
4. otherwise fail journal reconciliation with a journal-integrity error because
   a required notification has no historical evidence.

Only the selected carrier needs repositioning for K. Do not reposition both
categories merely because both exist.

A repositioned event preserves its original:

- action;
- key;
- identifier;
- time;
- creator;
- `eventId`.

It is not newly emitted.

### 7. Reconcile physical positions

The merge operates on two source replicas.

**Inputs:**

```
aH  = A.last_journal_index
bH  = B.last_journal_index
P   = max(aH, bH)
```

For every index `i` from `1` through `P`, derive the destination state:

1. **Both replicas have established state at `i`** (i ≤ aH and i ≤ bH):

   | A[ i ] | B[ i ] | target[ i ] |
   |---|---|---|
   | entry E | entry E | preserve E at i only when E is final canonical |
   | absent | absent | preserve absence at i |
   | entry E | absent | absence at i (see evidence preservation) |
   | absent | entry E | absence at i (see evidence preservation) |
   | entry E | entry F (E ≠ F) | poison: absence at i |

2. **Only A has established state at `i`** (i ≤ aH, i > bH):
   Preserve an A entry only when it is final canonical; otherwise establish
   absence.

3. **Only B has established state at `i`** (i > aH, i ≤ bH):
   The position is unestablished in A. Preserve a B entry only when it is
   final canonical; otherwise establish absence.

### 8. Normalize final canonical occurrences

For every final canonical event, gather its surviving destination positions. If
the same `eventId` survives at several physical positions:

- retain the occurrence with the greatest `JournalIndex`;
- make all lower occurrences absent;
- do not create another fresh copy.

If exactly one occurrence survives, retain it. If none survives, enqueue it via
`enqueueFresh(event)`. If a final canonical event already survives at a
positioned target entry, remove any queued fresh copy of the same `eventId`.

### 9. Enforce notification bounds

For each `K` in `SyncDelta`, let `carrier` be the notification carrier selected
in step 6.

- If `carrier` is a generated `delete` or `invalidate`, it was already enqueued
  by generated-event assignment. It will be allocated above `P` in step 10.
- Otherwise `carrier` is an existing event. If its greatest surviving position
  (after steps 7-8) is strictly greater than `P`, keep it. Otherwise remove
  its old occurrences and `enqueueFresh(carrier)`.

The bound is `P = max(aH, bH)`, not the watermark of whichever source is
locally active. This guarantees notification coverage for consumers that have
been following either source.

### 10. Fresh placement

Step 10 allocates exactly one physical occurrence for each member of
`FreshPlacementSet`. Every event enqueued during steps 5, 8, and 9 is allocated
contiguously at:

```
P + 1 .. P + n
```

The final watermark is `P + n`. After allocation, every final canonical logical
event has exactly one physical occurrence; no event is allocated twice merely
because several rules requested placement. The resulting physical journal equals
its own `logicalJournalView`.

Fresh entries are ordered by:

1. `time` ascending;
2. `NodeKeyString` ascending;
3. `journalCreatorToString(creator)` ascending;
4. Action rank: `add < edit < delete < invalidate < validate`;
5. `NodeIdentifier` ascending.

`journalCreatorToString` renders a `JournalCreator` deterministically (see
`incremental-graph-journal-types.md`). The ordering is deterministic and
independent of source direction: `time`, `NodeKeyString`, the creator rendering,
the action, and the identifier all derive from symmetric source evidence.

After allocating `n` queued events, set `last_journal_index = P + n`.

### Evidence preservation rule

When an entry is removed by same-index poisoning or present-versus-absence
conflict, if that entry is final canonical and has no other surviving position,
call `enqueueFresh(event)`. Otherwise do not queue it.

---

## Structural synchronization protocol

Synchronization uses the existing replica-switching architecture.

The outer lock scope is:

```
holidayActivity
→ closeGarden
→ construct merged inactive replica
→ final cutover
→ release in reverse order (closeGarden, then holidayActivity)
```

### Protocol steps

1. **Acquire `holidayActivity`.** Excludes ordinary graph activity and journal
   appends for the complete synchronization.

2. **Acquire `closeGarden`.** Excludes journal queries, compaction, structural
   synchronization, migration cutover, and other replica lifecycle operations.

3. **Select**:
   - the two exact source snapshots (A and B);
   - an inactive local replica as the destination.

4. **Clear or recreate the inactive destination** according to the existing
   replica-management design.

5. **Construct the complete merged graph and journal in that inactive
   destination.** The inactive destination may be written through multiple
   durable batches. Each batch that commits journal entries and associated graph
   records must keep them atomic with one another. Each standard transaction
   finalization acquires the destination darkroom.

6. **Do not mutate the source replicas** while constructing the destination.

7. **After all destination records are durable and internally consistent,
   acquire the destination/finalization darkroom.**

8. **Finish any required final destination metadata and atomically switch the
   active-replica pointer** to the completed destination.

9. **Release locks in reverse order.**

If synchronization fails before cutover, the previously active replica remains
active and unchanged.

### Query interaction

Because synchronization holds `closeGarden`, `possibleMaybeChanges` cannot
select or traverse a replica during synchronization or cutover. The query
continues to use `enterGarden` before selecting the active replica, read one
fixed `last_journal_index = H`, scan the selected active replica through `H`,
and release the garden afterward.

---

## Commutativity

Journal reconciliation is pairwise commutative. For two exact source snapshots
`A` and `B`:

- `SyncDelta` is symmetric by definition;
- the generated-event predicates are symmetric;
- sync creators, event IDs, timestamps, and identifier selection are derived
  symmetrically from source evidence;
- carrier placement is enforced above `P = max(aH, bH)`, which is symmetric;
- all fresh-placement ordering keys are symmetric.

Therefore `merge(A, B)` and `merge(B, A)` produce the same canonical journal and
the same fresh-placement sequence.

---

## Idempotence

Reconciling the same two exact source revisions again produces no new logical
sync event. If the same sync-derived event is generated again, its `eventId` is
identical, so placement deduplicates by `eventId` and no second logical event is
created.

Do not query previous journal events to determine idempotence.

---

## Interaction with compaction

Synchronization operates on each source's `logicalJournalView` at sync time. A
conforming physical compaction may have removed entries outside that view, but
it preserves every entry inside it, so source event selection is identical
before and after compaction.

Graph synchronization does not read journal state, so compaction cannot affect
graph synchronization correctness.

---

## Host identity and journal consumers

Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or
inspect host identities (`Hostname` values), sync creator sets (`Sync` values),
source revision identifiers, or raw journal indices (`JournalIndex` values).
Host identity, source revisions, and creator sets are journal-internal concerns
used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname`, `Sync`,
`SourceRevisionId`, and `JournalIndex` from its public fields. Consumers see
only `nodeName`, `bindings`, `action`, and `time`.

---

## Testable scenarios

### T1 — Journal integrity: conflicting payload

Source A: eventId "[\"host\",\"h1\",3]" with payload edit W1
Source B: eventId "[\"host\",\"h1\",3]" with payload edit W2

Synchronization aborts. Different payloads for the same eventId are an
integrity error.

### T2 — Generated invalidate becomes final freshness event

Source canonical: state = edit W, freshness = validate W
SyncDelta contains K: A up-to-date, B potentially-outdated, F potentially-outdated

Generated: invalidate(K, finalIdentifier)

```
finalCanonicalStateEvent(K)     = edit W (source retained)
finalCanonicalFreshnessEvent(K) = generated invalidate(K)
```

The generated invalidate has creator `Sync{A, B}`, a deterministic `time`
derived from the canonical source events for K, and a sync event ID that is
identical under `merge(A, B)` and `merge(B, A)`.

### T3 — Generated delete becomes final state event

Source canonical: state = edit W, freshness = validate W
A materialized, B unmaterialized, F unmaterialized

Generated: delete(K, identifier of the winning source materialization)

```
finalCanonicalStateEvent(K)     = generated delete(K)
finalCanonicalFreshnessEvent(K) = validate W (source retained)
```

### T4 — Delete dominates invalidate

A: K up-to-date
B: K unmaterialized
F: K unmaterialized

Emit only `delete`. No `invalidate`.

### T5 — Already stale emits nothing

A: K potentially-outdated
B: K potentially-outdated
F: K potentially-outdated

No generated event.

### T6 — Neither source materialized emits nothing

A: K unmaterialized
B: K unmaterialized
F: K unmaterialized

No generated event: the generated-delete predicate requires at least one source
to have materialized K, and neither source did.

(The former "host-only rejected node" case — one source materialized, the other
not, final unmaterialized — is not a no-event case. It satisfies the symmetric
generated-delete predicate and emits a `delete` so that consumers following the
materializing source are notified.)

### T7 — Identifier replacement emits no add or delete

A: K1 materializes K
B: K2 materializes K
F: K materialized (identifier-only replacement, equal value and freshness)

No delete, no add, no invalidate (unless freshness also changed). If freshness
changed up-to-date → stale, emit one invalidate using the final identifier.

### T8 — Repeated sync emits nothing new

First sync: A up-to-date, B stale, F stale, emits invalidate(K).
Second sync with the same source revisions: the same invalidate is generated
again with the same eventId; placement deduplicates and no second logical event
is created.

### T9 — Freshness history independent of state identifier

Source A: state = edit W1, freshness = invalidate W2
Source B: state = edit W1, freshness = invalidate W2

The canonical freshness event `invalidate W2` is retained even though
W2 !== W1. No filtering by identifier.

### T10 — Notification repositioning

Key K is in SyncDelta. `aH = 3`, `bH = 4`, so `P = 4`. The canonical state event
was at position 3. It is repositioned to position 6 (above P) so a cursor
holder on either source re-reads graph state.

### T11 — Cursor continuity without notification

Key K is NOT in SyncDelta. The canonical state event remains at its original
position. No repositioning.

### T12 — Poisoned index

Source A position 4: delete X
Source B position 4: edit X

Destination position 4 is absent. The winning canonical event is queued for
fresh placement above P.

### T13 — Source suffix preservation

aH = 3, bH = 7
B positions 5 and 6 contain canonical events. They remain at positions 5 and 6
in the destination because they are above aH.

### T14 — Compaction independence

After compaction removes obsolete entries, synchronization produces the same
canonical events and same notification behavior, because `logicalJournalView`
only contains required entries. Graph synchronization is unaffected.

### T15 — Idempotent fresh placement

A canonical source event E is present at position 3 in both sources. The same
event E is also the notification carrier for a SyncDelta key K. `P = 2`.

Step 7 (prefix merge): position 3 is canonical in both, preserved at i=3.
Step 8 (normalize): E survives at position 3.
Step 9 (enforce bounds): position 3 > P (3 > 2), so E is sufficient. No
`enqueueFresh(E)` call.

Scenario: position 3 is poisoned (different event in each source). Step 7
removes E from position 3. Step 8: no surviving occurrence — enqueueFresh(E).
Step 9: E is the carrier, no surviving position — enqueueFresh(E) (idempotent,
no duplicate). Step 10: one copy of E allocated above P.

### T16 — Fresh versus stale (commutativity)

```
A: K is materialized and up-to-date
B: K is materialized and potentially-outdated
F: K is materialized and potentially-outdated
```

Both `merge(A, B)` and `merge(B, A)` must generate the same `invalidate` event:

- same `action`;
- same key;
- same final identifier;
- same `Sync{A, B}` creator;
- same deterministic time;
- same event ID;
- same fresh position above `max(aH, bH)`.

### T17 — Materialized versus unmaterialized (commutativity)

```
A: K is materialized
B: K is unmaterialized
F: K is unmaterialized
```

Both merge directions must generate the same `delete` with the same identifier,
creator `Sync{A, B}`, deterministic time, event ID, and fresh position above P.

### T18 — Independent execution times

Host A and host B independently reconcile the same source revisions at different
wall-clock times. The generated journal results must still be identical. Local
synchronization execution time must not enter the event payload or event ID.

### T19 — Repeated reconciliation

Reconciling the same source revisions again must not create a second logical
sync event with a different identity. A regenerated sync event has the same
eventId and deduplicates against any surviving occurrence.

### T20 — New source revisions

A later pair of source revisions from the same host set may generate a new
event because the source revision identities differ, and therefore the sync
event ID differs.

---

## Normative labels

| Prefix | Category |
|--------|----------|
| PROP-JS- | Correctness properties |

**PROP-JS-01 (Downstream journal reconciliation):** Journal reconciliation never
alters final graph state. It records and notifies graph transitions determined
by graph synchronization.

**PROP-JS-02 (No ComputedValue inspection):** Journal reconciliation never
inspects, compares, hashes, or serializes `ComputedValue`s. The only integrity
check is `eventId` payload match.

**PROP-JS-03 (Historical-only notification):** A `PossibleNodeChange` reported
by journal reconciliation is historical notification evidence. It does not
assert current graph state.

**PROP-JS-04 (Sync emission idempotence):** Reconciling the same two exact
source revisions again produces no second logical sync event. A regenerated
sync event has an identical eventId and is deduplicated.

**PROP-JS-05 (Graph sync independence):** Graph synchronization correctness
does not depend on journal state, journal retention, or journal compaction.

**PROP-JS-06 (Pairwise commutativity):** `merge(A, B)` and `merge(B, A)` produce
the same canonical journal and the same fresh-placement sequence.

**PROP-JS-07 (Deterministic sync events):** Sync-derived events depend only on
the exact source revisions and the source journal evidence. They do not depend
on which source is locally active, on the host executing reconciliation, or on
the wall-clock time of merge execution.
