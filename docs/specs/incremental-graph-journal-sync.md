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
HGraph = staged host graph
FGraph = final graph produced by graph synchronization

LJournal = local established journal
HJournal = host established journal
FJournal = final journal after reconciliation
```

Graph synchronization receives only LGraph and HGraph. It does not receive
LJournal or HJournal.

Journal reconciliation receives LGraph, FGraph, LJournal, and HJournal.

---

## Graph/journal separation

- Journal actions are historical notification evidence.
- A retained journal event does not assert current graph state.
- It is valid for the latest retained journal event to describe an older state
  than the current final graph.
- Consumers must always re-read current graph state.

Graph synchronization never:

- consults canonical journal state to select identifier/value provenance;
- consults canonical journal freshness to determine final freshness;
- consults journal-compaction retention policy for evidence selection;
- inspects `ComputedValue`s from journal storage;
- compares `ComputedValue`s;
- uses journal-backed future synchronization.

Journal reconciliation never:

- selects `selectedSideByKey`;
- determines `outcomeByKey`;
- determines `finalIdentifierForKey`;
- alters graph materialization;
- alters graph freshness;
- transports validity proofs;
- creates deletion roots;
- computes deletion closure.

---

## Normative synchronization pipeline

Synchronization applies these stages in order.

### Stage 1 — Validate event identity across both committed prefixes

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

This is not two isolated per-source checks that might fail to compare an ID
appearing once in each source. Positions greater than a source's `last_journal_index`
are not established journal history and MUST NOT participate in identity
validation, logical-view construction, conflict resolution, or physical
reconciliation.

A payload disagreement for one `eventId` within the validated union is a
journal-integrity error: synchronization aborts, does not switch replicas,
leaves the old active replica unchanged, and neither poisons the occurrences nor
chooses a payload.

The journal payload includes action, key, identifier, time, and creator. It does
not include any `ComputedValue`.

### Stage 2 — Compute each source logical view from its committed prefix

For each source, compute:

```
logicalJournalView(sourceJournal, sourceH)
```

where `sourceH = source last_journal_index`. Storage above `sourceH` is outside
the committed prefix and is excluded from the logical view.

For each semantic key this produces at most one source state entry and one
source freshness entry. No physically redundant source event may affect conflict
resolution.

### Stage 3 — Select canonical journal events (journal-only)

Canonical journal events are the events retained in the final journal for each
semantic key. They are canonical only for journal retention and notification — they
do not assert graph state.

#### Canonical state event

For each semantic key:

- if neither source has a state entry, the destination has none;
- if only one source has a state entry, that existing event is canonical;
- if both have state entries, compare later `time`, then (when identifiers
  differ and times tie) lexicographically greater `NodeIdentifier`, then (when
  identifiers and times tie) lexicographically greater `eventId`.

The winning existing event is canonical. It is retained in the final journal
as historical notification evidence. It does not determine graph materialization,
identifier selection, or value provenance. Those are determined independently by
graph synchronization.

A canonical `delete` indicates that the most recent recorded journal action for
that key was a deletion. The current graph may be materialized even when the
latest journal event is `delete`.

#### Canonical freshness event

For each semantic key, let `W` be the canonical state event's identifier when
one exists. Consider each source freshness entry only when `entry.id === W`;
ignore freshness for another identifier. Compare candidates by later `time`,
then lexicographically greater `eventId` on a tie. The winner is the canonical
freshness event.

If neither source supplies freshness evidence for `W`, canonical freshness
history is absent.

For a key with no canonical state event (deleted key with no retained state
event), preserve no freshness event when neither source has one; preserve the
sole entry when only one source has one; and when both have entries preserve the
winner by later `time`, then lexicographically greater `eventId`. That winner is
canonical journal history only: it neither rematerializes the key nor assigns
graph freshness.

The canonical freshness event does not determine final graph freshness. Graph
synchronization determines final freshness from structural dependencies,
provenance, and conservative rules.

### Stage 4 — Graph synchronization (independent)

Graph synchronization runs independently per
`docs/specs/incremental-graph-synchronization.md`. It produces the final graph
state (FGraph) and a graph delta (DGraph) describing which semantic keys
transitioned materialization or freshness state.

Journal reconciliation does not inspect graph synchronization internals. It
receives only:

- LGraph (pre-sync active local graph);
- FGraph (final merged graph);
- the graph delta (optional implementation detail, derivable from LGraph and
  FGraph).

### Stage 5 — Emit sync-originated journal events

Synchronization may emit exactly two action types:

- `invalidate`
- `delete`

Synchronization never emits `add`, `edit`, or `validate`.

#### Sync-originated `invalidate`

For semantic key `K`, emit one `invalidate` exactly when:

```
LGraph(K) is materialized and up-to-date
FGraph(K) is materialized and potentially-outdated
```

Use:

```
event.action = "invalidate"
event.key   = K
event.id    = finalIdentifierForKey(K)
```

This applies to:

- direct hard-invalidation roots;
- propagated stale descendants;
- equal-version conservative downgrades;
- relowering-induced invalidation;
- every other actual up-to-date to potentially-outdated transition produced by
  graph sync.

Do not emit when:

- local K was already potentially-outdated;
- local K was unmaterialized;
- final K is unmaterialized;
- final K is up-to-date;
- only validity metadata changed;
- only the identifier changed while freshness stayed unchanged.

If the local identifier differs from the final identifier and freshness changes
from up-to-date to stale, use the final identifier.

#### Sync-originated `delete`

For semantic key `K`, emit one `delete` exactly when:

```
LGraph(K) is materialized
FGraph(K) is unmaterialized
```

Use:

```
event.action = "delete"
event.key   = K
event.id    = localIdentifierInLGraph(K)
```

This includes:

- direct deletion roots;
- every locally materialized transitive dependent removed by structural deletion
  closure.

Do not emit when:

- local K was already unmaterialized;
- K existed only on the host and its candidate was rejected;
- K remains materialized under another identifier;
- synchronization merely replaces one materialization with another.

Identifier replacement is not modeled as local `delete` plus synthetic `add`.

#### Delete dominates invalidate

When:

```
LGraph(K) is up-to-date
FGraph(K) is unmaterialized
```

emit only `delete`. Do not emit `invalidate` immediately before deletion.

#### Idempotence

Repeating synchronization between the same two stable source replicas emits no
duplicate event, because the pre-sync graph no longer contains the original
transition:

- stale → stale emits nothing;
- unmaterialized → unmaterialized emits nothing.

Do not query previous journal events to determine idempotence.

### Stage 6 — Existing-event notification repositioning

When graph synchronization changes the observable state for a semantic key but
does not emit a new sync-originated event (per Stage 5), the existing canonical
event may be repositioned above all source watermarks so that cursor-holding
callers are prompted to re-read graph state.

Notification-aware repositioning applies when any of these differ between a
source and the final destination:

- Canonical state event (`eventId`);
- Materialized versus unmaterialized;
- Current `NodeIdentifier`;
- Final graph state changed conservatively because of relowering or provenance
  (even when the canonical state event itself is unchanged).

When a sync-originated `invalidate` or `delete` was emitted for key `K`, the
new event is already the notification carrier. Do not additionally reposition an
older event solely to notify the same transition.

A repositioned event preserves its original:

- action;
- key;
- identifier;
- time;
- creator;
- `eventId`.

It is not newly emitted.

#### Notification bound computation

For a canonical event `E`, compute the set of sources that require `E` as
notification. Let:

```
notificationBound(E) = max(sourceH of every source requiring notification via E)
```

If no source requires notification via `E`, `E` has no notification bound.

#### Notification-aware normalization

During canonical-occurrence normalization, after gathering surviving positions
of `E`:

1. Keep only the greatest surviving position as the initial candidate.
2. If `E` has no notification bound:
   - retain that candidate;
   - if no occurrence survived, queue `E` for fresh placement.
3. If `E` has a notification bound `T`:
   - if the greatest surviving position is strictly greater than `T`, retain it;
   - otherwise make every old occurrence absent and queue `E` for fresh placement.
4. Fresh placement occurs above `P` (see Stage 8).

This ensures the canonical event ends up at a position strictly greater than
the watermark of every source that needed notification, prompting callers
whose cursor was before that watermark to re-read the graph.

### Stage 7 — Reconcile physical positions

The merge operates on two source replicas. For the local replica, the
established prefix through its committed watermark is finalized. For the remote
replica, its established prefix through its committed watermark is finalized.

**Inputs:**

```
localH  = local last_journal_index
remoteH = remote last_journal_index
P       = max(localH, remoteH)
```

**Prefix merge:** For every index `i` from `1` through `P`, derive the
destination state:

1. **Both replicas have established state at `i`** (i ≤ localH and i ≤ remoteH):

   | local[ i ] | remote[ i ] | target[ i ] |
   |---|---|---|
   | entry E | entry E | preserve E at i only when E is canonical |
   | absent | absent | preserve absence at i |
   | entry E | absent | absence at i (see evidence preservation) |
   | absent | entry E | absence at i (see evidence preservation) |
   | entry E | entry F (E ≠ F) | poison: absence at i |

2. **Only local has established state at `i`** (i ≤ localH, i > remoteH):
   Preserve a local entry only when it is canonical; otherwise establish
   absence. Preserve local absence.

3. **Only remote has established state at `i`** (i > localH, i ≤ remoteH):
   The position is unestablished locally. Preserve a remote entry only when it
   is canonical; otherwise establish absence. Preserve remote absence.

The entire prefix state through `P` is resolved before fresh entries are
allocated.

### Stage 8 — Normalize canonical occurrences

For every canonical event, gather its surviving destination positions. If the
same `eventId` survives at several physical positions:

- retain the occurrence with the greatest `JournalIndex`;
- make all lower occurrences absent;
- do not create another fresh copy.

If exactly one occurrence survives, retain it. If none survives, queue that same
event for fresh placement. Thus a positioned canonical event is never queued,
and every queued event is canonical and has no surviving positioned copy.

### Stage 9 — Fresh placement

Canonical events that have no surviving positioned occurrence (including those
queued by notification-aware normalization) are allocated at:

```
P + 1 .. P + n
```

The final watermark is `P + n`.

#### Fresh-entry ordering

Fresh entries are ordered by:

1. `time` ascending;
2. `NodeKeyString` ascending;
3. `creator` ascending;
4. Action rank: `add < edit < delete < invalidate < validate`;
5. `NodeIdentifier` ascending.

`NodeIdentifier` values are globally and historically unique. Do not add any
further criterion after `NodeIdentifier`.

Allocate the ordered entries contiguously at `P + 1 .. P + n`.

### Destination logical view canonicalization

After physical index reconciliation, the destination physically contains exactly:

- the canonical state event for each key;
- the canonical freshness event for each key, when one exists.

Every obsolete or duplicate occurrence is absent. Fresh placement preserves the
queued event's exact action, identifier, key, time, creator, and `eventId`.

After allocating `n` queued events contiguously at `P + 1 .. P + n`, set
`last_journal_index = P + n`. The completed destination therefore has at most
one physical occurrence of each `eventId` and physically equals
`logicalJournalView(journal, P + n)`.

#### Required displaced evidence

Entry-versus-established-absence reconciliation and same-index poisoning use one
rule. The destination position is absent. If the removed event is canonical and
has no other surviving position, queue that same event for fresh placement.
Otherwise do not queue it. This rule covers canonical `add`, `edit`, `delete`,
`invalidate`, and `validate` events and excludes every obsolete event.

---

## Structural synchronization protocol

Synchronization uses the existing replica-switching architecture. It does not
introduce any database-state abstraction beyond the replicas that already exist
in the IncrementalGraph design.

The outer lock scope is:

```
holidayActivity
→ closeGarden
→ construct merged inactive replica
→ final cutover
→ release in reverse order (closeGarden, then holidayActivity)
```

### Protocol steps

1. **Acquire `holidayActivity`.** This excludes daytime activity, nighttime
   activity, pulls, invalidations, and ordinary journal appends for the complete
   synchronization.

2. **Acquire `closeGarden`.** This excludes journal queries, compaction,
   structural synchronization, migration cutover, and other replica lifecycle
   operations.

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
   finalization acquires the destination darkroom. The darkroom may be acquired
   and released per durable batch; it is not held for the entire potentially
   long-running destination construction.

6. **Do not mutate the active local replica** while constructing the
   destination.

7. **After all destination records are durable and internally consistent,
   acquire the destination/finalization darkroom.**

8. **Finish any required final destination metadata and atomically switch the
   active-replica pointer** to the completed destination. Publish volatile
   active-replica state only after the durable cutover succeeds.

9. **Release locks in reverse order.**

If synchronization fails before cutover:

- the old active replica remains active and unchanged;
- the incomplete inactive replica may be discarded or rebuilt later;
- readers never observe the incomplete replica.

### Query interaction

Because synchronization holds `closeGarden`, `possibleMaybeChanges` cannot
select or traverse a replica during synchronization or cutover. The query
continues to use `enterGarden` before selecting the active replica, read one
fixed `last_journal_index = H`, scan the selected active replica through `H`,
and release the garden afterward.

---

## Physical journal convergence

One synchronization invocation modifies only the local inactive destination and
then switches the local active pointer. It does not modify the fetched remote
host.

Given the same two stable source replicas, the merge rules produce the same
complete destination journal regardless of which source is described first. This
deterministic pairwise merge guarantees:

- the same graph state;
- the same canonical journal events;
- the same state for every physical journal position;
- the same fresh-entry ordering;
- the same final watermark.

A one-sided synchronization run produces that deterministic destination locally.
The remote host converges only after it separately obtains and installs
equivalent merged data through the broader synchronization mechanism.

### Resolving divergent indices

If the two source replicas have different `JournalEntry` values at the same
`JournalIndex` `i`, the destination poisons that index. Both conflicting entries
are deleted from index `i` in the destination. A conflicting event is queued
above `P` only when it is canonical and has no other surviving position.

### Present-versus-absence conflict

If one source replica has an established journal entry at index `i` and the
other has an established absence at the same index `i`, the destination
establishes absence at index `i`. The present entry is removed in the
destination.

If the removed event is canonical and has no other surviving position, queue the
same event for fresh placement. Otherwise do not reappend it. This is the same
rule used for same-index poisoning.

### Remote suffix

For `localH < i ≤ remoteH`, the local source has no established state at `i`. A
canonical remote event at `i` may remain at `i` in the destination. A
noncanonical remote event is omitted. Because synchronization holds
`holidayActivity`, there is no concurrent ordinary append that can claim the
position.

---

## Pairwise synchronization

Specify deterministic pairwise synchronization only. For the same two stable
source replicas:

- the merge rules produce the same merged destination;
- input direction does not affect physical journal reconciliation;
- input direction does not affect fresh-entry ordering.

This specification does not cover:

- general multi-host convergence;
- associativity;
- global revision graphs;
- immutable synchronization results propagated among all hosts;
- a proof that arbitrary repeated pairwise ordering terminates;
- three-host conformance scenarios.

A future specification may address general multi-host convergence.

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

## Sync order

Sync SHOULD process remote journal entries in ascending `JournalIndex` order for
deterministic traversal. `JournalIndex` order is not a global causal order
across hosts. Divergent same-index entries are handled by the poisoned-index
rule.

---

## Testable scenarios

### T1 — Stored freshness contradicts invalidate

Source:

```
state: materialized W, stored freshness = up-to-date
journal logical view: state = edit W, freshness = invalidate W
```

This scenario is valid. The journal event `invalidate` is historical; it does
not guarantee current graph freshness. The graph may be `up-to-date` even when
a retained journal event says `invalidate`. No integrity error occurs.

### T2 — Validate history with conservative downgrade

Source:

```
state: materialized W, stored freshness = potentially-outdated
journal logical view: state = edit W, freshness = validate W
```

This is a valid conservative-downgrade scenario. The retained `validate`
permits up-to-date but does not force it. Graph synchronization may
conservatively produce `potentially-outdated` when relowering or provenance
rules require it. The canonical freshness event (`validate W`) is retained in
the journal; the graph freshness is `potentially-outdated`.

### T3 — Direct sync invalidation

LGraph: K materialized, up-to-date
FGraph: K materialized, potentially-outdated

Result: emit `invalidate(K, finalIdentifier(K))`.

### T4 — Propagated sync invalidation

```
A → B → C
```

If B and C each transition locally from up-to-date to potentially-outdated, emit
one `invalidate` for each.

### T5 — Already stale

LGraph: K potentially-outdated
FGraph: K potentially-outdated

Emit nothing.

### T6 — Direct deletion

LGraph: K materialized
FGraph: K unmaterialized

Emit `delete(K, localIdentifier(K))`.

### T7 — Deletion closure

```
A, B → D → E → F
```

If D, E, and F were locally materialized and final graph removes all three,
emit one `delete` for each.

### T8 — Host-only rejected node

LGraph: K unmaterialized
HGraph: K materialized
FGraph: K unmaterialized

Emit no `delete`.

### T9 — Identifier replacement

LGraph: K1 materializes K
FGraph: K2 materializes K

Emit no `delete` and no `add`. Use existing-event notification repositioning
when needed. If freshness also transitions from local up-to-date to final stale,
emit one `invalidate` using K2.

### T10 — Delete dominates invalidate

LGraph: K up-to-date
FGraph: K unmaterialized

Emit only `delete`.

### T11 — Journal and graph disagree historically

A retained journal event may describe an older state than the current final
graph. This is valid and must not cause a graph/journal consistency error.

### T12 — Repeated synchronization

After the first sync emitted `invalidate` or `delete`, running the same
effective sync again emits nothing.

### T13 — Validate history with stale migration creation

Source:

```
state: materialized W, stored freshness = potentially-outdated
journal logical view: state = add W, no matching freshness event
```

This is valid. The journal event `add W` means an event exists; it does not
assert current freshness. Graph synchronization determines final freshness from
structural rules.

### T14 — Missing journal prefix

Source `A` has:

```
positions 1..3: add X, validate X, invalidate X
last_journal_index = 3
```

Source `B` has:

```
positions 1..3: add X, validate X, invalidate X
last_journal_index = 3
```

Both established prefixes match. The canonical state event is the winning `add`
or `edit`; the canonical freshness event is the winning `invalidate` or
`validate`.

### T15 — Same canonical event with different origins

Source A: canonical state event `add W`, W materialized
Source B: canonical state event `add W`, W materialized

Both sources contribute the same canonical event. Journal reconciliation
preserves one copy. No `ComputedValue` comparison occurs.

### T16 — Fresh-event allocation above former conflict

Source A: index 3 has `add X`
Source B: index 3 has `add Y`

Destination position 3 is poisoned (absent). The winning canonical event is
queued for fresh placement above P.

### T17 — Cursor continuity with notification

A same-process cursor was at position 2 before synchronization. The canonical
state event `add W` was at position 2 in one source and was repositioned to
position 5 for notification. The cursor holder sees position 5 as a new change
and re-reads graph state.

### T18 — Cursor continuity without fresh event

A same-process cursor was at position 2 before synchronization. The canonical
state event `add W` was at position 2 in one source and remains at position 2
after reconciliation (no notification needed because destination equals source).
The cursor holder sees no new change for key W.

### T19 — Compaction independence

After compaction removes obsolete entries, synchronization produces the same
canonical events and same notification behavior, because `logicalJournalView`
only contains canonical entries. Graph synchronization correctness is unaffected
because graph sync never reads journal state.

### T20 — Store freshness prior to last journal

The source graph is:

```
state: materialized W, stored freshness = up-to-date
journal logical view: state = edit W, freshness = invalidate W
```

No integrity error. The `invalidate` event is retained as journal history. Graph
freshness (`up-to-date`) is determined by graph synchronization, not by journal
history.

---

## Normative labels

| Prefix | Category |
|--------|----------|
| TERM-JS- | Terminology definitions |
| REQ-JS- | Normative requirements |
| PROP-JS- | Correctness properties |

**PROP-JS-01 (Downstream journal reconciliation):** Journal reconciliation never
alters final graph state. It records and notifies graph transitions determined
by graph synchronization.

**PROP-JS-02 (No ComputedValue inspection):** Journal reconciliation never
inspects, compares, hashes, or serializes `ComputedValue`s. The only integrity
check is `eventId` payload match.

**PROP-JS-03 (Historical-only notification):** A `PossibleNodeChange` reported
by journal reconciliation is historical notification evidence. It does not
assert current graph state. Consumers must always re-read current graph state.

**PROP-JS-04 (Sync emission idempotence):** Emitting an `invalidate` or `delete`
for a key during reconciliation produces no duplicate event when the same
reconciliation is repeated between the same stable source replicas.

**PROP-JS-05 (Graph sync independence):** Graph synchronization correctness
does not depend on journal state, journal retention, or journal compaction.
