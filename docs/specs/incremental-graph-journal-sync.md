# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how journal state is reconciled during synchronization between hosts. Synchronization produces one complete merged inactive replica, which replaces the active replica only after it is durable and complete.

Synchronization does **not** create new logical journal events. It works only with journal events that were already emitted by ordinary graph operations, migration operations, freshness transitions, and actual node deletion operations.

---

## Normative synchronization pipeline

Synchronization applies these stages in order. Physical source redundancy never
participates in conflict selection.

### Stage 1 — Validate event identity within the committed prefix

For each source, validate every physically present occurrence at indices `1 ..
sourceH` where `sourceH = source last_journal_index`. For every such occurrence,
the same `eventId` MUST identify the same immutable payload. Copies may occupy
different physical positions.

Positions greater than `sourceH` are not established journal history. They MUST
NOT participate in identity validation, logical-view construction, conflict
resolution, or physical reconciliation. If the storage design guarantees that
positions above `sourceH` cannot exist, that is an invariant rather than an
open-ended validation boundary — state it explicitly rather than ambiguously
validating an unbounded journal.

A payload disagreement for one `eventId` within the validated prefix is a
journal-integrity error: synchronization aborts, does not switch replicas,
leaves the old active replica unchanged, and neither poisons the occurrences nor
chooses a payload.

### Stage 2 — Compute each source logical view from its committed prefix

For each source, compute:

```
logicalJournalView(sourceJournal, sourceH)
```

where `sourceH = source last_journal_index`. Storage above `sourceH` is outside
the committed prefix and is excluded from the logical view.

For each semantic key this produces at most its source state entry and source
freshness entry. No physically redundant source event may affect conflict
resolution.

### Stage 3 — Select canonical state

For each semantic key:

- if neither source has a state entry, the destination has none;
- if only one source has a state entry, that existing event is canonical;
- if both have state entries, compare later `time`, then (when identifiers
  differ and times tie) lexicographically greater `NodeIdentifier`, then (when
  identifiers and times tie) lexicographically greater `eventId`.

The winning existing event is canonical. `add` or `edit` materializes the key
using that event's `NodeIdentifier` and associated source graph value. `delete`
leaves it nonmaterialized. Synchronization creates no event.

### Stage 4 — Validate source graph and freshness consistency

For each source key, let S be its source state entry and F its source freshness
entry from `logicalJournalView(sourceJournal, sourceH)`.

#### Materialized source node

Suppose a source has a materialized node with identifier `W`. Require:

1. S exists.
2. S.action is `add` or `edit`.
3. S.id === W.

Then validate freshness.

**Matching freshness event.** If F exists and F.id === W, the source graph's
stored freshness MUST agree with F.action:

```
F.action === "invalidate" → graph freshness === "potentially-outdated"
F.action === "validate"   → graph freshness === "up-to-date"
```

Any disagreement is a journal-integrity error.

**No matching freshness event.** If F does not exist or F.id !== W, the
current node incarnation has no recorded freshness transition. Its stored
freshness MUST therefore be `up-to-date`. This covers first materialization,
which emits `add` but not `validate`, and rematerialization with a new
identifier where an older incarnation's retained freshness history does not
apply to `W`. A `potentially-outdated` materialized node without a matching
`invalidate` is inconsistent and synchronization must fail.

#### Nonmaterialized source key

If the source has state evidence for the key, its latest state entry MUST be
`delete`. A retained freshness event is historical only and does not assign
graph freshness.

#### Orphan freshness history

A source freshness entry for a semantic key with no source state entry is
invalid. Every legitimate freshness event originates from an existing node
incarnation, and `logicalJournalView` never removes that incarnation's latest
state entry.

#### On any consistency failure

Abort synchronization without applying the prepared target. Do not switch
replicas. Leave the active replica unchanged. Do not repair the source silently.
Do not choose graph storage over journal evidence. Do not choose journal
evidence over graph storage.

### Stage 5 — Select canonical freshness

For a canonically materialized key, let the winning identifier be `W`. Consider
each source freshness entry only when `entry.id === W`; ignore freshness for
another identifier. Compare candidates by later `time`, then lexicographically
greater `eventId` on a tie. The winner is the canonical freshness event:
`invalidate` makes the graph `potentially-outdated`, while `validate` makes it
`up-to-date`. If neither source supplies freshness evidence for `W`, use the
winning source graph state's stored freshness. First materialization without
freshness evidence is up to date.

For a canonically deleted key, freshness never sets graph state. Preserve no
freshness event when neither source has one; preserve the sole entry when only
one source has one; and when both have entries preserve the winner by later
`time`, then lexicographically greater `eventId`. That winner is canonical
journal history only: it neither rematerializes the key nor assigns graph
freshness.

### Wall-clock resolution

A host's wall clock may be incorrect, but it is the available conflict-ordering
signal. The system trusts hosts and does not rely on an external time authority.

---

## Structural synchronization protocol

Synchronization uses the existing replica-switching architecture. It does not introduce any database-state abstraction beyond the replicas that already exist in the IncrementalGraph design.

```
holidayActivity
→ closeGarden
→ construct merged inactive replica
→ darkroom
→ finish durable metadata and switch active replica
→ release darkroom
→ release closeGarden
→ release holidayActivity
```

### Protocol steps

1. **Acquire `holidayActivity`.** This excludes daytime activity, nighttime activity, pulls, invalidations, and ordinary journal appends.

2. **Acquire `closeGarden`.** This excludes journal queries, compaction, structural synchronization, migration cutover, and other replica lifecycle operations.

3. **Select**:
   - the current active local replica as the local source;
   - the fetched remote replica as the remote source;
   - an inactive local replica as the destination.

4. **Clear or recreate the inactive destination** according to the existing replica-management design.

5. **Construct the complete merged graph and journal in that inactive destination.** This step builds the merged journal prefix and appends any displaced evidence. See §Journal merge rules.

6. **Do not mutate the active local replica** while constructing the destination.

7. **After the destination is complete, acquire the destination/finalization darkroom.**

8. **Finish any required durable metadata and atomically switch the active-replica pointer** to the completed destination.

9. **Release locks in reverse order:** darkroom → closeGarden → holidayActivity.

If synchronization fails before cutover:
- the old active replica remains active and unchanged;
- the incomplete inactive replica may be discarded or rebuilt later;
- readers never observe the incomplete replica.

### Query interaction

Because synchronization holds `closeGarden`, `possibleMaybeChanges` cannot select or traverse a replica during synchronization or cutover. The query continues to use `enterGarden` before selecting the active replica, read one fixed `last_journal_index = H`, scan the selected active replica through `H`, and release the garden afterward.

---

## Why no new sync event is needed

`possibleMaybeChanges` reports possible changes, not an exact command log.

When synchronization changes the graph:
- the remote `add`, `edit`, `delete`, `invalidate`, or `validate` event that caused the change is already journal evidence for the affected key;
- if that evidence occupies a remote suffix position, it is copied into the same unestablished numeric position;
- if its old numeric position conflicts with established local state, it is reappended at a fresh position;
- a caller receiving that event re-reads the current graph state.

Therefore the existing causal event is sufficient. An additional synthetic notification would duplicate evidence without adding information.

### Identifier conflict

When two identifiers for the same semantic key conflict:
- determine the graph winner using the existing timestamp and `NodeIdentifier` rules;
- preserve the relevant existing events for the winner and loser according to journal retention rules;
- do not emit an additional synthetic `delete` or `edit`.

The existing conflicting events already indicate that the semantic key may have changed. Consumers must re-check current graph state.

---

## Journal merge rules

### Physically canonical destination

The completed inactive destination physically contains exactly its logical
journal view. For each semantic node key it contains at most one state event
(`add`, `edit`, or `delete`) and at most one freshness event (`invalidate` or
`validate`). Every noncanonical event is absent. This construction is the
equivalent of physical compaction and cannot change `possibleMaybeChanges`,
because noncanonical events are already excluded by `logicalJournalView`.

Synchronization does not preserve obsolete entries merely as physical history,
and it never reappends a canonical event merely to outrank an obsolete event at
a greater index. It omits the obsolete event instead.

### Stage 6 — Reconcile physical positions

The merge operates on two source replicas. For the local replica, the established prefix through its committed watermark is finalized. For the remote replica, its established prefix through its committed watermark is finalized.

**Inputs:**
```
localH  = local last_journal_index
remoteH = remote last_journal_index
P       = max(localH, remoteH)
```

**Prefix merge:** For every index `i` from `1` through `P`, derive the destination state:

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

The entire prefix state through `P` is resolved before fresh entries are allocated.

### Stage 7 — Normalize canonical occurrences

For every canonical event, gather its surviving destination positions. If the
same `eventId` survives at several physical positions:
- retain the occurrence with the greatest `JournalIndex`;
- make all lower occurrences absent;
- do not create another fresh copy.

If exactly one occurrence survives, retain it. If none survives, queue that same
event for fresh placement. Thus a positioned canonical event is never queued,
and every queued event is canonical and has no surviving positioned copy.

### Stage 8 — Fresh placement

Canonical events that have no surviving positioned occurrence are allocated at:

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

`NodeIdentifier` values are globally and historically unique. Do not add any further criterion after `NodeIdentifier`.

Allocate the ordered entries contiguously at `P + 1 .. P + n`.

### Destination logical view canonicalization

REQ-JS-07: After physical index reconciliation, the destination physically
contains exactly:

- the canonical state event for each key;
- the canonical freshness event for each key, when one exists.

Every obsolete or duplicate occurrence is absent. Fresh placement preserves the
queued event's exact action, identifier, key, time, creator, and `eventId`.
After allocating `n` queued events contiguously at `P + 1 .. P + n`, set
`last_journal_index = P + n`. The completed destination therefore has at most
one physical occurrence of each `eventId` and physically equals
`logicalJournalView(journal, P + n)`.

Synchronization still does not create any logical event.

#### Required displaced evidence

REQ-JS-08: Entry-versus-established-absence reconciliation and same-index
poisoning use one rule. The destination position is absent. If the removed event
is canonical and has no other surviving position, queue that same event for
fresh placement. Otherwise do not queue it. This rule covers canonical `add`,
`edit`, `delete`, `invalidate`, and `validate` events and excludes every obsolete
event.

---

## Physical journal convergence

One synchronization invocation modifies only the local inactive destination and then switches the local active pointer. It does not modify the fetched remote host.

Given the same two stable source replicas, the merge rules produce the same complete destination journal regardless of which source is described first. This deterministic pairwise merge guarantees:

- the same graph winner;
- the same state for every physical journal position;
- the same freshness winner;
- the same fresh-entry ordering;
- the same final watermark.

A one-sided synchronization run produces that deterministic destination locally. The remote host converges only after it separately obtains and installs equivalent merged data through the broader synchronization mechanism.

### Resolving divergent indices

If the two source replicas have different `JournalEntry` values at the same `JournalIndex` `i`, the destination poisons that index. Both conflicting entries are deleted from index `i` in the destination. A conflicting event is queued above `P` only when it is canonical and has no other surviving position.

### Present-versus-absence conflict

If one source replica has an established journal entry at index `i` and the other has an established absence at the same index `i`, the destination establishes absence at index `i`. The present entry is removed in the destination.

If the removed event is canonical and has no other surviving position, queue the same event for fresh placement. Otherwise do not reappend it. This is the same rule used for same-index poisoning.

### Remote suffix

For `localH < i ≤ remoteH`, the local source has no established state at `i`. A canonical remote event at `i` may remain at `i` in the destination. A noncanonical remote event is omitted. Because synchronization holds `holidayActivity`, there is no concurrent ordinary append that can claim the position.

---

## Pairwise synchronization

Specify deterministic pairwise synchronization only. For the same two stable source replicas:
- the merge rules produce the same merged destination;
- input direction does not affect graph conflict winners;
- input direction does not affect physical journal reconciliation;
- input direction does not affect fresh-entry ordering.

This PR does not specify:
- general multi-host convergence;
- associativity;
- global revision graphs;
- immutable synchronization results propagated among all hosts;
- a proof that arbitrary repeated pairwise ordering terminates;
- three-host conformance scenarios.

A future specification may address general multi-host convergence.

---

## Interaction with compaction

Sync operates on each source's `logicalJournalView` at sync time. A conforming
physical compaction may have removed entries outside that view, but it preserves
every entry inside it, so source conflict selection is identical before and
after compaction. Synchronization MUST NOT fall back to graph `timestamps`
sublevel records as replacement journal evidence.

---

## Host identity and journal consumers

Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Sync order

Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. `JournalIndex` order is not a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule.

---

## Testable scenarios

### T1 — Stored freshness contradicts invalidate

Source:
```
state: materialized W, stored freshness = up-to-date
journal logical view: state = edit W, freshness = invalidate W
```

Synchronization fails with an integrity error. It must not silently make the
node stale or ignore the event.

### T2 — Stored freshness contradicts validate

Source:
```
state: materialized W, stored freshness = potentially-outdated
journal logical view: state = edit W, freshness = validate W
```

Synchronization fails.

### T3 — Missing invalidate

Source:
```
state: materialized W, stored freshness = potentially-outdated
journal logical view: state = add W, no matching freshness event
```

Synchronization fails: a potentially-outdated node must have a matching
invalidate.

### T4 — First materialization

Source:
```
state: materialized W, stored freshness = up-to-date
journal logical view: state = add W, no matching freshness event
```

This is valid. First materialization emits `add` but not `validate`.

### T5 — Old-incarnation freshness

Source:
```
state: materialized W2, stored freshness = up-to-date
journal logical view: state = add W2, freshness = invalidate W1
```

This is valid source history. The `invalidate W1` belongs to an older
incarnation and does not make `W2` stale.

### T6 — Self-synchronization stability

An already conforming, physically canonical source synchronized with an
identical copy. Expected result:

- identical graph value;
- identical graph freshness;
- identical canonical state event;
- identical canonical freshness event;
- identical event positions;
- no fresh append;
- unchanged watermark.

This verifies that valid freshness evidence cannot silently change graph
freshness during synchronization.

### T7 — Remote suffix preserved at same index (no race)

```
local H = 5
remote H = 6, remote[6] = E

sync constructs inactive destination
index 6 is unestablished locally (6 > 5)
sync replicates E at index 6 in the inactive destination
sync commits H = 6
```

The remote entry is preserved at its original numeric position because it was unestablished locally.

### T8 — Pre-sync same-index conflict

An ordinary append commits `F` at local index 6 before synchronization acquires
`holidayActivity`; the remote source has `E` at index 6. Synchronization poisons
index 6. No ordinary append overlaps synchronization after the holiday begins.

#### Same semantic key and category

When `E` and `F` are state events for the same semantic key, only the Stage 3
winner is canonical. Only that winner is freshly placed above `P`, preserving
its `eventId`; the loser is omitted.

#### Different semantic keys or categories

When `E` and `F` belong to different semantic keys, or are canonical entries in
different categories, both may be canonical. Both are freshly placed above `P`
in the Stage 8 canonical ordering. Their exact positions cannot be stated unless
all ordering fields are supplied.

### T9 — Present-versus-absent propagation

```
Host A: index 5 = E
Host B: index 5 = absent (compacted)
```

Absence wins at index 5. If E is canonical and has no other surviving position, exactly one copy is freshly placed at index 6. Otherwise E is omitted.

### T10 — Sparse remote suffix

```
Local H = 5
Remote H = 100, indices 6..99 absent, index 100 = E
```

Canonical prefix: indices 6..99 = absence, index 100 = E, H = 100.

### T11 — Fresh entry ordering

Two displaced entries: E1 (time=100) and E2 (time=200). Order by time ascending, then by the other canonical fields. Assign contiguous positions above P.

### T12 — Duplicate event at several retained positions

```
index 3 = event X (eventId = "...")
index 8 = event X (eventId = "...")
```

Canonical result: index 3 = absent, index 8 = event X. The greatest position survives.

### T13 — Event ID integrity violation

```
Host A: eventId X with payload E
Host B: eventId X with payload F (different)
```

Synchronization fails with integrity error. No journal or graph mutation is committed. The entries are not poisoned or deduplicated.

### T14 — No synthetic sync event

A remote edit wins graph conflict. The destination preserves or reappends the original remote edit event. The number of logical events does not increase merely because synchronization occurred.

### T15 — Sync freshness conflict (winning identifier)

```
Host A:
  canonical value candidate id = A1
  validate A1, time 100

Host B:
  winning value candidate id = B1
  invalidate A1 (losing identifier), time 150
  validate B1, time 200

Graph winner: B1
```

Only freshness evidence for B1 participates. The `invalidate` for A1
cannot make B1 stale. Merged inactive destination:
- X is up to date (validate B1);
- only the `validate` event for B1 survives as freshness evidence;
- the `invalidate` for A1 is removed as obsolete;
- no new event is created.

### T16 — Replica-switch failure

Synchronization fails while constructing the inactive destination. The old active replica remains selected. The old active graph and journal remain unchanged. The incomplete inactive destination is never visible.

### T17 — Replica cutover

After the inactive destination is complete:
- `closeGarden` prevents readers from selecting a replica during cutover;
- the active pointer switches;
- later readers select only the new replica.

### T18 — Canonical lower, obsolete higher

```
index 5 = canonical edit E
index 8 = obsolete edit F
```

The destination retains E at index 5, makes index 8 absent, and does not append
another E.

### T19 — Canonical freshness displaced by absence

The winning `validate` event is physically displaced during reconciliation (the source that provides it has established absence at that index on the other side). The destination reappends that same event above `P`, preserving its `eventId`.

### T20 — No obsolete reappend

An older noncanonical `edit` event for a key is displaced during physical reconciliation (e.g., its position is poisoned). It is NOT reappended merely because it existed. Only canonical state and canonical freshness events are preserved.


### T21 — One-sided state

Source A has `add X`. Source B has no state event and no graph record for X. The
existing `add` is canonical and materializes X.

### T22 — Deleted freshness comparison

Source A's latest freshness is `invalidate X` at time 100. Source B's is
`validate X` at time 200, and canonical graph state is deleted. The destination
preserves only `validate X` as canonical journal history. It does not
rematerialize X or assign graph freshness.

### T23 — Canonical duplicate

```
index 5 = canonical event E
index 9 = same eventId E
```

The destination preserves E at index 9, makes index 5 absent, and does not append
a third copy.

### T24 — Canonical event physically displaced

A canonical `validate`, `delete`, `add`, or `edit` loses every old position
through established absence or same-index poisoning. Synchronization places
exactly one fresh copy above `P`, preserving its `eventId` and complete payload.
The same rule applies to canonical `invalidate`.

### T25 — Repeated synchronization

A completed destination is synchronized again with either original source. The
same canonical state and freshness events remain. Positioned canonical events
survive normalization, so no additional copies are appended.
