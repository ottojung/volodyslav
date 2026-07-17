# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how journal state is reconciled during synchronization between hosts. Synchronization produces one complete merged inactive replica, which replaces the active replica only after it is durable and complete.

Synchronization does **not** create new logical journal events. It works only with journal events that were already emitted by ordinary graph operations, migration operations, freshness transitions, and actual node deletion operations.

---

## Normative synchronization pipeline

Synchronization applies these stages in order. Physical source redundancy never
participates in conflict selection.

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

The canonical state event selects the identifier/value provenance. Graph-level
decisions about whether the candidate value may remain cached, must become
missing, or must be downgraded to potentially-outdated are governed by the
graph synchronization specification (`docs/specs/incremental-graph-synchronization.md`),
not by the journal synchronization specification.

For each semantic key:

- if neither source has a state entry, the destination has none;
- if only one source has a state entry, that existing event is canonical;
- if both have state entries, compare later `time`, then (when identifiers
  differ and times tie) lexicographically greater `NodeIdentifier`, then (when
  identifiers and times tie) lexicographically greater `eventId`.

The winning existing event is canonical. `add` or `edit` materializes the key
using that event's `NodeIdentifier`. The associated graph value is the cached
value from whichever source supplies the event as its latest state event; if
that source has no cached value (missing), the destination is materialized but
missing. `delete` leaves it nonmaterialized. Synchronization creates no event.

The canonical state event does not override a graph-synchronization requirement
to delete the candidate cached value, make the node missing, or downgrade it to
potentially-outdated. Those outcomes are determined by the graph synchronization
rules (value provenance, dependency relowering, conservative freshness).

### Stage 4 — Validate source graph and freshness consistency

For each source key, let S be its source state entry and F its source freshness
entry from `logicalJournalView(sourceJournal, sourceH)`.

#### Materialized source node

Suppose a source has a materialized node with identifier `W`. The node may be
**cached** (has a stored value, freshness is `up-to-date` or
`potentially-outdated`) or **missing** (has no stored value, freshness is
`"missing"`). Require:

1. S exists.
2. S.action is `add` or `edit`.
3. S.id === W.

Then validate state and freshness.

**Cached source node.** When a source has a cached value for `W`, the
following consistency checks apply.

_Matching freshness event._ If F exists and F.id === W, the source graph's
stored freshness MUST agree with F.action:

```
F.action === "invalidate" → graph freshness === "potentially-outdated"
F.action === "validate"   → graph freshness === "up-to-date"
```

Any disagreement is a journal-integrity error.

_No matching freshness event._ If F does not exist or F.id !== W, the
current node incarnation has no recorded freshness transition. The validity
depends on S.action:

- If S.action is `add`, the stored freshness may be either `up-to-date` or
  `potentially-outdated` — it is the node incarnation's initial freshness
  inherited from its first materialization. Examples include ordinary first
  materialization (normally up to date), `storage.create(..., "up-to-date")`,
  and `storage.create(..., "potentially-outdated")`. No synthetic freshness
  event is required.

- If S.action is `edit`, the source is inconsistent. Every conforming
  value-changing recomputation emits both `edit` and `validate`. A
  materialized node whose latest state entry is `edit` but lacks matching
   freshness evidence cannot establish its stored freshness under this
   specification. Synchronization must fail.

### Source consistency matrix

For each source semantic key, let:

```
S = source latest state entry
F = source latest freshness entry
W = source materialized NodeIdentifier (from graph storage)
```

The following table defines whether a source is internally consistent for a
given combination of state action, cached-value presence, and graph freshness.

| State action | Cached? | Graph freshness | F exists? | F.id? | Valid? |
|---|---|---|---|---|---|
| `add`/`edit` | yes | `up-to-date` | yes | == W | valid (F must be `validate`) |
| `add`/`edit` | yes | `up-to-date` | no | — | valid (S must be `add`) |
| `add`/`edit` | yes | `up-to-date` | yes | != W | valid (older-incarnation history) |
| `add`/`edit` | yes | `potentially-outdated` | yes | == W | valid (any F action) |
| `add`/`edit` | yes | `potentially-outdated` | no | — | valid (S must be `add`) |
| `add`/`edit` | yes | `potentially-outdated` | yes | != W | valid (older-incarnation history) |
| `edit` | yes | `up-to-date` | no | — | **INVALID** |
| `edit` | yes | `potentially-outdated` | no | — | **INVALID** |
| `add`/`edit` | no | `missing` | any | any | valid (F is historical) |
| `delete` | no | n/a | any | any | valid (F is historical) |
| none | — | n/a | yes | any | **INVALID** (orphan) |

Additional rules:

- When a cached node's graph freshness is `up-to-date` and a matching `F`
  exists and `F.id === W`, `F.action` MUST be `validate`. A matching
  latest `invalidate` with current graph state `up-to-date` is an integrity
  error.
- When a cached node's graph freshness is `potentially-outdated` and a
  matching `F` exists and `F.id === W`, `F.action` may be `invalidate` or
  `validate` (the latter followed by a conservative graph-freshness
  downgrade).
- When graph freshness is `missing`, F is historical only and does not assign
  current freshness. A matching `validate` or `invalidate` may remain from
  before synchronization removed the cached value.
- When `F.id !== W`, F is history for an older incarnation and does not
  describe W.
- A freshness event with no state event for the semantic key (orphan
  freshness) remains invalid.

**Missing source node.** When a source has a missing node for `W`
(freshness `"missing"`, no value), the source is consistent only if:

1. S exists and S.action is `add` or `edit`.
2. S.id === W.
3. The missing state arose from a prior conservative synchronization or
   other valid structural removal — not from event evidence.

A missing source node with freshness `"missing"` is valid. F is historical
only and does not assign current freshness. A matching `validate` or
`invalidate` may remain from before the cached value was removed; that is
permitted journal history.

#### Nonmaterialized source key

If the source has state evidence for the key, its latest state entry MUST be
`delete`. A retained freshness event is historical only and does not assign
graph freshness.

#### Orphan freshness history

A source freshness entry for a semantic key with no source state entry is
invalid. Every legitimate freshness event originates from an existing node
incarnation, and `logicalJournalView` never removes that incarnation's latest
state entry.

#### Identical-state conflicting-initial-freshness integrity check

When both sources contain the same canonical state event (same `eventId`,
same immutable payload) and neither source has an applicable freshness event
for the winning identifier `W`, both sources' stored initial freshness values
for `W` MUST agree. If one source stores `W` as `up-to-date` and the other as
`potentially-outdated`, synchronization fails with an integrity error. The same
state `eventId` associated with different stored initial freshness values is
not a direction-dependent choice — the result must be the same regardless of
which replica is described first.

#### On any consistency failure

Abort synchronization without applying the prepared target. Do not switch
replicas. Leave the active replica unchanged. Do not repair the source silently.
Do not choose graph storage over journal evidence. Do not choose journal
evidence over graph storage.

### Candidate value origins

For a canonical `add` or `edit` event E for key K, the internal proof set
`candidateValueOrigins(K)` contains one origin for each source where:

- that source's latest state event (from its `logicalJournalView`) is E;
- its current materialized identifier is `E.id`;
- it currently has a cached value.

A missing source (no cached value) contributes no cached-value origin.

#### Cached-value integrity for multiple origins

When two sources contribute cached-value origins for the same canonical event:

- their cached values must be `isEqual`;
- differing values are an integrity error;
- equal values denote the same candidate semantic value.

When one source is cached and the other is missing:

- do not compare the cached value with absence;
- do not treat absence as corruption;
- the cached source contributes one candidate origin;
- the graph provenance and relowering rules decide whether that value may
  survive.

When all canonical-event sources are missing:

- the final node is materialized but missing;
- no cached value is invented.

#### Value provenance

Value origin is determined by the graph synchronization specification
(`docs/specs/incremental-graph-synchronization.md` §9). A surviving cached
value may be preserved with its source-side origin, downgraded to potentially
outdated, or removed entirely — but the canonical `eventId` and `NodeIdentifier`
are never replaced by the losing source's identifier or value.

#### Integrity error on divergent cached values

If the cached values are not `isEqual`:

- fail synchronization with an integrity error;
- do not choose the local value;
- do not choose the remote value;
- do not switch replicas;
- leave the current active replica unchanged;
- do not poison the event's positions merely because the graph values disagree.

The graph value is not part of `JournalEntry`, `JournalEventId`, or the
immutable journal-payload serialization.

### Stage 5 — Select canonical freshness history

This stage selects the canonical freshness event retained in the destination
journal. The final graph freshness is determined by the graph synchronization
rules (see `docs/specs/incremental-graph-synchronization.md` §8). The canonical
freshness history event does not by itself force the graph freshness — a
retained `validate` permits but does not force `up-to-date`, and a retained
`invalidate` forbids `up-to-date` unless a later canonical `validate` exists.

For a canonically materialized key, let the winning identifier be `W`. Consider
each source freshness entry only when `entry.id === W`; ignore freshness for
another identifier. Compare candidates by later `time`, then lexicographically
greater `eventId` on a tie. The winner is the canonical freshness history event.

If neither source supplies freshness evidence for `W`, canonical freshness
history is absent. The node's initial freshness (which may be `up-to-date` or
`potentially-outdated`) is stored graph state, not journal history; it is
preserved as part of the canonical graph state.

For a canonically deleted key, freshness never sets graph state. Preserve no
freshness event when neither source has one; preserve the sole entry when only
one source has one; and when both have entries preserve the winner by later
`time`, then lexicographically greater `eventId`. That winner is canonical
journal history only: it neither rematerializes the key nor assigns graph
freshness.

### Final graph freshness

The retained canonical freshness event does not force the final graph freshness.
The graph synchronization rules determine:

- If the retained event is `validate`, the graph may still be
  `potentially-outdated` or `missing` if relowering, provenance requirements,
  or conservative freshness rules require it.
- If the retained event is `invalidate`, the graph must not be `up-to-date`
  unless a later canonical `validate` exists.
- If the destination must produce a missing node (materialized identifier,
  no cached value), the canonical freshness event is retained as journal
  history only; it does not assign graph freshness.

Graph-level decisions about cached-value removal, freshness downgrade, and
missing-state production are governed by the graph synchronization
specification (`docs/specs/incremental-graph-synchronization.md`).

### Wall-clock resolution

A host's wall clock may be incorrect, but it is the available conflict-ordering
signal. The system trusts hosts and does not rely on an external time authority.

---

## Structural synchronization protocol

Synchronization uses the existing replica-switching architecture. It does not introduce any database-state abstraction beyond the replicas that already exist in the IncrementalGraph design.

The outer lock scope is:

```
holidayActivity
→ closeGarden
→ construct merged inactive replica
→ final cutover
→ release in reverse order (closeGarden, then holidayActivity)
```

### Protocol steps

1. **Acquire `holidayActivity`.** This excludes daytime activity, nighttime activity, pulls, invalidations, and ordinary journal appends for the complete synchronization.

2. **Acquire `closeGarden`.** This excludes journal queries, compaction, structural synchronization, migration cutover, and other replica lifecycle operations.

3. **Select**:
   - the current active local replica as the local source;
   - the fetched remote replica as the remote source;
   - an inactive local replica as the destination.

4. **Clear or recreate the inactive destination** according to the existing replica-management design.

5. **Construct the complete merged graph and journal in that inactive destination.** See §Journal merge rules. The inactive destination may be written through multiple durable batches. Each batch that commits journal entries and associated graph records must keep them atomic with one another. Each standard transaction finalization acquires the destination darkroom. The darkroom may be acquired and released per durable batch; it is not held for the entire potentially long-running destination construction.

6. **Do not mutate the active local replica** while constructing the destination.

7. **After all destination records are durable and internally consistent, acquire the destination/finalization darkroom.**

8. **Finish any required final destination metadata and atomically switch the active-replica pointer** to the completed destination. Publish volatile active-replica state only after the durable cutover succeeds.

9. **Release locks in reverse order.**

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
- the existing canonical event — whether `add`, `edit`, `delete`, `invalidate`, or `validate` — is already journal evidence for the affected key;
- if that evidence occupies a remote suffix position, it is copied into the same unestablished numeric position;
- if its old numeric position conflicts with established local state, it is reappended at a fresh position;
- a caller receiving that event re-reads the current graph state.

Therefore the existing canonical event is sufficient. An additional synthetic notification would duplicate evidence without adding information.

### Identifier conflict

When two identifiers for the same semantic key conflict:
- determine the graph winner using the existing timestamp and `NodeIdentifier` rules;
- preserve the canonical state winner and, when one exists, the canonical freshness event;
- omit the losing state event;
- omit obsolete freshness events;
- do not emit a synthetic `delete` or `edit`.

The existing canonical event is sufficient because consumers re-read current graph state. The winner may originate from either source.

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

### Stage 7a — Notification coverage

A same-process caller may hold a `PossibleNodeChange` cursor from before
synchronization. If synchronization changes the logical journal winner or the
graph-observable state for a semantic key, the caller must receive a retained
canonical event strictly after its old source watermark, so it is prompted to
re-read the graph state. Synchronization satisfies this by repositioning an
existing canonical event. It still creates no logical event.

Two separate notification carrier sets are defined per semantic key:
**state-notification sources** and **freshness-notification sources**. A source
may appear in neither, one, or both sets depending on how its state and final
destination diverge.

#### State-notification sources

A source requires state notification via the canonical state event when any of
these differs between the source and the final destination for the affected
semantic key:

- Canonical state event (`eventId`);
- Materialized versus nonmaterialized;
- Current `NodeIdentifier`;
- Cached versus missing;
- Cached semantic value (when both are cached, `isEqual` comparison);
- Final graph state changed conservatively because of relowering or provenance
  (even when the canonical state event itself is unchanged).

#### Freshness-notification sources

A source requires freshness notification via the canonical freshness event when
its latest freshness event differs from the final canonical freshness-history
event:

- One absent and the other exists;
- Both exist with different `eventId`.

When graph freshness changes from up-to-date to stale or missing but the
canonical freshness event itself is unchanged (e.g., conservative downgrade
after a retained `validate`), use the canonical state event as the notification
carrier. Do not reposition a `validate` or `invalidate` merely because a value
or cached/missing state changed.

#### Notification bound computation

For a canonical event E, compute the set of sources that require E as
notification:

- If E is a state event (`add`, `edit`, `delete`): use the state-notification
  sources for E's semantic key.
- If E is a freshness event (`invalidate`, `validate`): use the
  freshness-notification sources for E's semantic key.

Let:

```
notificationBound(E) = max(sourceH of every source requiring notification via E)
```

If no source requires notification via E, E has no notification bound.

#### Notification-aware normalization

During canonical-occurrence normalization, after gathering surviving positions
of E:

1. Keep only the greatest surviving position as the initial candidate.
2. If E has no notification bound:
   - retain that candidate;
   - if no occurrence survived, queue E for fresh placement.
3. If E has a notification bound T:
   - if the greatest surviving position is strictly greater than T, retain it;
   - otherwise make every old occurrence absent and queue E for fresh placement.
4. Fresh placement occurs above P (see Stage 8).

This ensures the canonical event ends up at a position strictly greater than
the watermark of every source that needed notification, prompting callers
whose cursor was before that watermark to re-read the graph.

#### Determinism and idempotence

The notification rule is symmetric. It depends only on:

- both source watermarks;
- both source logical views;
- both source graph states;
- the deterministic final graph and journal state.

It does not depend on which source is called local.

After the first synchronization, the repositioned canonical event is above the
watermark of every source that needed notification. When the merged result is
synchronized again with one of those original sources, the already positioned
canonical event satisfies that source's notification bound; no further append
is needed.

### Stage 8 — Fresh placement

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

### T3 — Stale migration creation

Source:
```
state: materialized W, stored freshness = potentially-outdated
journal logical view: state = add W, no matching freshness event
```

This is valid. The `add` without matching freshness evidence uses its
associated stored initial freshness, which is `potentially-outdated`.
Synchronization preserves this freshness.

### T3a — Missing freshness after edit

Source:
```
state: materialized W, stored freshness = potentially-outdated (or up-to-date)
journal logical view: state = edit W, no matching freshness event
```

Synchronization fails. A conforming edit must have matching `validate`
evidence. An `edit` incarnation without freshness evidence cannot establish
its stored freshness.

### T3b — Fresh creation

Source:
```
state: materialized W, stored freshness = up-to-date
journal logical view: state = add W, no matching freshness event
```

This is valid. Freshness is `up-to-date`.

### T4 — First materialization

Source:
```
state: materialized W, stored freshness = up-to-date
journal logical view: state = add W, no matching freshness event
```

This is valid. The `add` supplies the node incarnation's initial freshness
(up-to-date in this case). First materialization emits `add` but not
`validate`.

### T5 — Old-incarnation freshness

Source:
```
state: materialized W2, stored freshness = up-to-date
journal logical view: state = add W2, freshness = invalidate W1
```

This is valid source history. The `invalidate W1` belongs to an older
incarnation and does not make `W2` stale.

### T5a — Override preserves fresh state

```
Before override:
    W is up-to-date
    latest freshness event = validate W

After storage.override:
    W is up-to-date (freshness inherited)
    existing validate W remains latest freshness evidence
    no new journal event emitted
```

Override preserves freshness unchanged and emits no journal entry.

### T5b — Override preserves stale state

```
Before override:
    W is potentially-outdated
    latest freshness event = invalidate W

After storage.override:
    W remains potentially-outdated (freshness inherited)
    existing invalidate W remains latest freshness evidence
    no new journal event emitted
```

Override preserves freshness unchanged and emits no journal entry.

### T5c — Identical event with conflicting initial freshness

Both sources contain the same `add` event (same `eventId`, same immutable
payload) and no matching freshness event. One source stores `W` as
`up-to-date` and the other as `potentially-outdated`.

Synchronization fails with an integrity error. The same state `eventId`
associated with different stored initial freshness values is not a
direction-dependent choice.

### T5d — Identical state event, consistent freshness

Both sources contain the same `add` event with no matching freshness event.
Both store `W` as `up-to-date`. Synchronization succeeds; `W` is up to date.

### T5e — Same event, divergent graph values

```
Source A:
  state event E: action = edit, eventId = X
  stored graph value for node: value A

Source B:
  state event E: action = edit, eventId = X (same eventId, same immutable payload)
  stored graph value for node: value B

isEqual(value A, value B) === false
```

Synchronization fails with an integrity error. The active replica remains
unchanged. The event occurrences are not poisoned or arbitrarily assigned a
value. The journal payload is identical — the divergence is in the associated
graph value, which is not part of the immutable journal payload.

### T5f — Same event, equal graph values

```
Source A:
  state event E: action = add, eventId = X
  stored graph value for node: value A

Source B:
  state event E: action = add, eventId = X (same eventId, same immutable payload)
  stored graph value for node: value B

isEqual(value A, value B) === true
```

Synchronization succeeds and produces the same canonical graph value regardless
of which source is described first. The canonical event is unambiguous; the
canonical graph value is that common semantic value.

### T5g — Same event, conflicting initial freshness (independent of graph-value check)

Both sources contain the same `add` event (same `eventId`, same payload).
Graph values are `isEqual`. However, source A stores `up-to-date` and source B
stores `potentially-outdated` as the initial freshness. Synchronization fails.
Graph-value equality and initial-freshness equality are independent integrity
checks.

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

Assuming E is canonical:

```
local H = 5
remote H = 6, remote[6] = E

sync constructs inactive destination
index 6 is unestablished locally (6 > 5)
sync replicates E at index 6 in the inactive destination
sync commits H = 6
```

The remote entry is preserved at its original numeric position because it was unestablished locally. A noncanonical remote suffix event is omitted.

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

Assuming E is canonical:

```
Local H = 5
Remote H = 100, indices 6..99 absent, index 100 = E
```

Canonical prefix: indices 6..99 = absence, index 100 = E, H = 100.

If E is noncanonical, index 100 is absent in the physically canonical destination.

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
  index 2 = add A1
  index 5 = validate A1, time 100
  canonical value candidate id = A1
  logical-view freshness entry for A1 = index 5 (validate)

Host B:
  index 3 = add B1
  index 4 = invalidate A1 (losing identifier), time 150
  index 6 = validate B1, time 200
  winning value candidate id = B1
  logical-view freshness entry for B1 = index 6 (validate)

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

### T26 — Synchronization notification: canonical event repositioned

```
Source A: H = 5, state event E at index 5
Source B: H = 8, state event F at index 8

E wins (earlier time, but canonical).
```

E at index 5 is not after B's watermark (8). The notification bound for E is
max(5, 8) = 8. The greatest surviving position of E is 5, which is not strictly
greater than 8. E is queued for fresh placement:

```
Destination:
  index 5 = absent
  index 8 = absent (F loses, omitted)
  index 9 = E (preserving original eventId)
  H = 9
```

A caller on B's source with `since = F@8` now receives `E@9` and re-reads the
graph.

### T27 — Repeated sync notification idempotence

Synchronize the destination from T26 with Source B again:

```
Merged: H = 9, E at 9
Source B: H = 8, F at 8
```

E at 9 is already strictly after Source B's watermark (8). The notification
bound for E is satisfied. The destination retains E at 9. It does not append E
again. No new logical event is created.

### T28 — Conservative missing-state notification

Both sources contain the same canonical state event E at index 5 and cached
graph values. Graph synchronization determines that dependency relowering makes
the final cached value unsafe and removes it:

```
Final:
  materialized identifier preserved
  value absent
  freshness = missing
```

The final graph state differs from both source graph states. E at index 5 is
not after either source watermark. Notification bound for E is
max(localH, remoteH). Move the same event:

```
Destination:
  index 5 = absent
  index 6 = E (preserving original eventId)
  H = 6
```

No new logical event is created. A later query after either source's old cursor
receives E@6 and re-reads the now-missing node. On repeated synchronization
with an original source whose H is 5, E@6 already provides notification and is
not moved again.
