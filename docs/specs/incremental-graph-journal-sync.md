# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how journal state is reconciled after graph
synchronization has independently produced its final graph state.

Graph synchronization is fully specified by
`docs/specs/incremental-graph-synchronization.md` and does not inspect or depend
on journal state. Journal reconciliation runs downstream from the completed
graph merge.

---

## Input model

```
LGraph = pre-sync active local graph
FGraph = final graph produced by graph synchronization
GraphDelta = semantic keys requiring journal notification

LJournal = local established journal
HJournal = host established journal
```

Graph synchronization produces FGraph and GraphDelta. Journal reconciliation
receives LGraph, FGraph, GraphDelta, LJournal, and HJournal.

---

## Graph/journal separation

- Journal actions are truthful historical evidence.
- A retained journal event does not assert current graph state.
- It is valid for the latest retained journal event to describe an older state
  than the current final graph.
- Consumers must always re-read current graph state.

---

## Conceptual reconciliation order

Journal reconciliation follows this conceptual order. Stages that involve
durable storage use the structural synchronization protocol described below.

### 1. Graph synchronization determines FGraph and GraphDelta

Graph synchronization independently produces the final merged graph. Journal
reconciliation does not participate in graph planning.

### 2. Validate event identity across both committed prefixes

Event-ID integrity is checked over the union of established occurrences from
both sources:

```
local  positions 1 .. localH
union
remote positions 1 .. remoteH
```

If one `eventId` appears once locally and once remotely, those two occurrences
MUST have identical immutable journal payloads. The same `eventId` MUST identify
the same immutable payload regardless of which source an occurrence resides in.
Copies may occupy different physical positions.

Positions greater than a source's `last_journal_index` are not established
journal history and MUST NOT participate in identity validation, logical-view
construction, conflict resolution, or physical reconciliation.

A payload disagreement for one `eventId` within the validated union is a
journal-integrity error: synchronization aborts, does not switch replicas,
leaves the old active replica unchanged, and neither poisons the occurrences nor
chooses a payload.

The journal payload includes action, key, identifier, time, and creator. It does
not include any `ComputedValue`.

### 3. Compute each source logical journal view

For each source, compute:

```
logicalJournalView(sourceJournal, sourceH)
```

where `sourceH = source last_journal_index`. Storage above `sourceH` is outside
the committed prefix and is excluded from the logical view.

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

- if neither source has a freshness entry, the source canonical freshness event
  is absent;
- if only one source has a freshness entry, that existing event is canonical;
- if both have freshness entries, compare by later `time`, then lexicographically
  greater `eventId` on a tie.

The winner is the source canonical freshness event. It is historical journal
evidence only: it does not determine final graph freshness or assert current
graph state. The retained freshness event may refer to an older identifier than
the retained state event.

### 5. Apply exact generated events from LGraph → FGraph

Synchronization may newly emit only:

- `invalidate`
- `delete`

It never emits `add`, `edit`, or `validate`.

#### Generated `delete`

Emit one `delete` for semantic key K when:

```
LGraph(K) is materialized
FGraph(K) is unmaterialized
```

Use:

```
event.action = "delete"
event.key   = K
event.id    = identifier of the deleted local materialization
```

#### Generated `invalidate`

Emit one `invalidate` for semantic key K when:

```
LGraph(K) is materialized and up-to-date
FGraph(K) is materialized and potentially-outdated
```

Use:

```
event.action = "invalidate"
event.key   = K
event.id    = final materialization identifier of K in FGraph
```

#### Delete dominates invalidate

When LGraph(K) is materialized and FGraph(K) is unmaterialized, emit only
`delete`. Do not emit `invalidate` before deletion.

#### Generated event assignment

Every generated event begins unpositioned. It is always queued for fresh
placement above `P = max(localH, remoteH)`.

Assign:

```
action   = "invalidate" or "delete"
key      = K
id       = as specified above
time     = current synchronization event time
creator  = local host
```

After its fresh `JournalIndex` is allocated, assign the ordinary event ID:

```js
JSON.stringify([
    hostnameToString(creator),
    journalIndexToNumber(originIndex),
])
```

No special sync event type or alternate ID format.

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

### 6. Ensure notification coverage

Every key in GraphDelta must have notification evidence positioned after all
source watermarks that require notification.

For keys that received a generated `invalidate` or `delete`, the generated event
is already the notification carrier. No additional repositioning is needed.

For other keys in GraphDelta where no sync-originated event was emitted, the
existing canonical event may be repositioned to a position strictly above the
watermarks of sources that require notification.

A repositioned event preserves its original:

- action;
- key;
- identifier;
- time;
- creator;
- `eventId`.

It is not newly emitted.

#### Notification bound

For a final canonical event E, compute:

```
notificationBound(E) = max(sourceH of every source requiring notification via E)
```

If no source requires notification via E, E has no notification bound.

During normalization, after gathering surviving positions of E:

1. Keep only the greatest surviving position as the initial candidate.
2. If E has no notification bound, retain that candidate. If no occurrence
   survived, queue E for fresh placement.
3. If E has a notification bound T:
   - if the greatest surviving position is strictly greater than T, retain it;
   - otherwise make every old occurrence absent and queue E for fresh placement.

### 7. Reconcile physical positions

The merge operates on two source replicas.

**Inputs:**

```
localH  = local last_journal_index
remoteH = remote last_journal_index
P       = max(localH, remoteH)
```

For every index `i` from `1` through `P`, derive the destination state:

1. **Both replicas have established state at `i`** (i ≤ localH and i ≤ remoteH):

   | local[ i ] | remote[ i ] | target[ i ] |
   |---|---|---|
   | entry E | entry E | preserve E at i only when E is final canonical |
   | absent | absent | preserve absence at i |
   | entry E | absent | absence at i (see evidence preservation) |
   | absent | entry E | absence at i (see evidence preservation) |
   | entry E | entry F (E ≠ F) | poison: absence at i |

2. **Only local has established state at `i`** (i ≤ localH, i > remoteH):
   Preserve a local entry only when it is final canonical; otherwise establish
   absence.

3. **Only remote has established state at `i`** (i > localH, i ≤ remoteH):
   The position is unestablished locally. Preserve a remote entry only when it
   is final canonical; otherwise establish absence.

### 8. Normalize final canonical occurrences

For every final canonical event, gather its surviving destination positions. If
the same `eventId` survives at several physical positions:

- retain the occurrence with the greatest `JournalIndex`;
- make all lower occurrences absent;
- do not create another fresh copy.

If exactly one occurrence survives, retain it. If none survives, queue that
event for fresh placement.

### 9. Fresh placement

Final canonical events with no surviving positioned occurrence are allocated
contiguously at:

```
P + 1 .. P + n
```

The final watermark is `P + n`.

Fresh entries are ordered by:

1. `time` ascending;
2. `NodeKeyString` ascending;
3. `creator` ascending;
4. Action rank: `add < edit < delete < invalidate < validate`;
5. `NodeIdentifier` ascending.

`NodeIdentifier` values are globally and historically unique.

After allocating `n` queued events, set `last_journal_index = P + n`.

### Evidence preservation rule

When an entry is removed by same-index poisoning or present-versus-absence
conflict, if that entry is final canonical and has no other surviving position,
queue it for fresh placement. Otherwise do not queue it.

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
   - the current active local replica as the local source;
   - the fetched remote replica as the remote source;
   - an inactive local replica as the destination.

4. **Clear or recreate the inactive destination** according to the existing
   replica-management design.

5. **Construct the complete merged graph and journal in that inactive
   destination.** The inactive destination may be written through multiple
   durable batches. Each batch that commits journal entries and associated graph
   records must keep them atomic with one another. Each standard transaction
   finalization acquires the destination darkroom.

6. **Do not mutate the active local replica** while constructing the
   destination.

7. **After all destination records are durable and internally consistent,
   acquire the destination/finalization darkroom.**

8. **Finish any required final destination metadata and atomically switch the
   active-replica pointer** to the completed destination.

9. **Release locks in reverse order.**

If synchronization fails before cutover, the old active replica remains active
and unchanged.

### Query interaction

Because synchronization holds `closeGarden`, `possibleMaybeChanges` cannot
select or traverse a replica during synchronization or cutover. The query
continues to use `enterGarden` before selecting the active replica, read one
fixed `last_journal_index = H`, scan the selected active replica through `H`,
and release the garden afterward.

---

## Idempotence

After one synchronization installs FGraph locally, repeating reconciliation
against the same unchanged host state produces no additional sync-originated
event when GraphDelta is empty (no key transitions between LGraph and FGraph).

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
inspect host identities (`Hostname` values) or raw journal indices
(`JournalIndex` values). Host identity is a journal-internal concern used only
during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and
`JournalIndex` from its public fields. Consumers see only `nodeName`,
`bindings`, `action`, and `time`.

---

## Testable scenarios

### T1 — Journal integrity: conflicting payload

Source A: eventId "[\"h1\",3]" with payload edit W1
Source B: eventId "[\"h1\",3]" with payload edit W2

Synchronization aborts. Different payloads for the same eventId are an
integrity error.

### T2 — Generated invalidate becomes final freshness event

Source canonical: state = edit W, freshness = validate W
GraphDelta contains K, L up-to-date → F stale

Generated: invalidate(K, finalIdentifier)

```
finalCanonicalStateEvent(K)     = edit W (source retained)
finalCanonicalFreshnessEvent(K) = generated invalidate(K)
```

### T3 — Generated delete becomes final state event

Source canonical: state = edit W, freshness = validate W
L materialized, F unmaterialized

Generated: delete(K, localIdentifier)

```
finalCanonicalStateEvent(K)     = generated delete(K)
finalCanonicalFreshnessEvent(K) = validate W (source retained)
```

### T4 — Delete dominates invalidate

L: K up-to-date
F: K unmaterialized

Emit only `delete`. No `invalidate`.

### T5 — Already stale emits nothing

L: K potentially-outdated
F: K potentially-outdated

No generated event.

### T6 — Host-only rejected node emits nothing

L: K unmaterialized
H: K materialized
F: K unmaterialized

No generated event. No local transition occurred.

### T7 — Identifier replacement emits no add or delete

L: K1 materializes K
F: K2 materializes K

No delete, no add, no invalidate (unless freshness also changed). If freshness
changed up-to-date → stale, emit one invalidate using K2.

### T8 — Repeated sync emits nothing

First sync: K up-to-date → stale, emits invalidate(K).
Second sync: L now stale, F still stale. No transition, no event.

### T9 — Freshness history independent of state identifier

Source A: state = edit W1, freshness = invalidate W2
Source B: state = edit W1, freshness = invalidate W2

The canonical freshness event `invalidate W2` is retained even though
W2 !== W1. No filtering by identifier.

### T10 — Notification repositioning

Key K was in GraphDelta. Source watermark = 5. The canonical state event
was at position 3. It is repositioned to position 7 (above watermark 5)
so the cursor holder re-reads graph state.

### T11 — Cursor continuity without notification

Key K was NOT in GraphDelta. The canonical state event remains at its
original position. No repositioning.

### T12 — Poisoned index

Source A position 4: delete X
Source B position 4: edit X

Destination position 4 is absent. The winning canonical event is queued
for fresh placement above P.

### T13 — Remote suffix preservation

localH = 3, remoteH = 7
Remote positions 5 and 6 contain canonical events. They remain at positions
5 and 6 in the destination because they are above localH.

### T14 — Compaction independence

After compaction removes obsolete entries, synchronization produces the same
canonical events and same notification behavior, because `logicalJournalView`
only contains required entries. Graph synchronization is unaffected.

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

**PROP-JS-04 (Sync emission idempotence):** After one synchronization installs
FGraph locally, repeating reconciliation against the same unchanged host state
produces no duplicate sync-originated event when GraphDelta is empty.

**PROP-JS-05 (Graph sync independence):** Graph synchronization correctness
does not depend on journal state, journal retention, or journal compaction.
