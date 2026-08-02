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

Each source snapshot carries a `SourceSnapshotProvenance` whose `id` identifies
its exact synchronization-relevant logical state, together with a per-host
`CausalFrontier`, the merge protocol version, and the schema version (see
`incremental-graph-journal-types.md` § Logical snapshot identity). Snapshots
are transport-neutral: a staged logical snapshot is an exact frozen logical
state, however it was transported.

Graph synchronization produces `F` and the symmetric journal synchronization
delta `SyncDelta` defined below. Journal reconciliation receives `A`, `B`, `F`,
`SyncDelta`, and the two source journals. It must not inspect or compare
`ComputedValue`s itself.

## Logical snapshot provenance

Every synchronization input and output snapshot carries a
`SourceSnapshotProvenance`:

```js
/**
 * @typedef {object} SourceSnapshotProvenance
 * @property {LogicalSnapshotId} id
 * @property {CausalFrontier} causalFrontier
 * @property {string} graphAndJournalMergeProtocolVersion
 * @property {Version} schemaVersion
 */
```

- An exported logical snapshot staged from a host receives a `LogicalSnapshotId`
  of its exact logical state, a `causalFrontier` that maps that hostname to its
  own current coordinate (instance and logical version) and preserves every
  remote coordinate the host had already incorporated, the currently advertised
  merge protocol version, and the source's schema version.
- A deterministic merge result receives a `LogicalSnapshotId` of its exact
  merged logical state, a `causalFrontier` equal to
  `unionCausalFrontiers(left.causalFrontier, right.causalFrontier)`, and
  preserves the inputs' merge protocol and schema versions.

The protocol and schema versions are persisted as explicit compatibility
metadata, stored separately even though they are also hashed into the
`LogicalSnapshotId`. Pairwise merge rejects inputs with mismatching merge
protocol or schema versions before graph or journal reconciliation. The frontier
union additionally rejects inputs whose frontiers record unresolvable
coordinates for a common hostname (in particular, a different `HostInstanceId`
for the same hostname, an administrative conflict); see § Causal frontier and
the synchronization gate.

The merged destination's provenance must be durably established before that
destination can become active or be used as the source of a later per-host
merge. The provenance must survive the root-database reopen that occurs between
successive per-host merges. A failed merge must not publish the destination
provenance.

A `SourceSnapshotProvenance` describes one exact synchronization-relevant
source state. Ordinary graph or journal activity after the snapshot was taken
makes the provenance inapplicable to the resulting mutable replica. At the
beginning of synchronization, while graph activity is excluded, the exact local
source is frozen/exported and fresh provenance is derived for that precise
logical snapshot; this provenance is used as the local source's provenance for
the first per-host merge. An export derives its frontier with
`localExportCausalFrontier`: it preserves every remote entry of the previous
frontier and updates only the local hostname's coordinate, advancing that
coordinate only when the host actually originated new logical graph or journal
state since the prior export (the local `HostInstanceId` never changes). Each
derived merge output receives persisted provenance before it can become the
next local source.

For a sync-derived event created while merging source snapshots `A` and `B`:

```
creator = makeSync(causalFrontierHostnames(unionCausalFrontiers(
    A.provenance.causalFrontier,
    B.provenance.causalFrontier)))
```

The union of the two frontiers is the merged frontier, so the creator is
exactly the contributor set of the merged snapshot: the set of contributing
source hosts represented by the two merge inputs. Because a merge unions the
two input frontiers, later multi-host synchronization may legitimately produce
`creator = Sync{A, B, C}`: the creator is the set of hostnames present in the
merged frontier, not necessarily just the two hosts involved in the latest
exchange. The contributor set is derived from the frontier's hostname keys and
is never maintained as an independent value, so the two can never disagree.

---

## Causal frontier and the synchronization gate

The causal frontier makes synchronization a fixed point for unchanged hosts and
prevents repeated re-notification and acknowledgement churn. The frontier maps
each contributing hostname to a `HostStateCoordinate`: the pair of the storage
instance and the host's transport-independent logical state version already
incorporated (see `incremental-graph-journal-types.md` § HostStateCoordinate
and § Causal frontier).

### Synchronization gate

Before constructing a merged destination for a staged logical snapshot, the
implementation MUST compare the complete staged frontier with the local
frontier using `dominatesCausalFrontier(local, staged)`. The comparison covers
every hostname represented by the staged frontier, not merely the hostname of
the host that supplied the snapshot: a staged snapshot may contain contributions
originating from several hosts.

The gate is sound only because the graph-and-journal merge is a canonical
logical join over a persisted, merge-closed basis — commutative, associative,
and idempotent (see `incremental-graph-synchronization.md` § 1b Logical join and
§ Merge basis). When the local frontier dominates a staged frontier, the staged
snapshot contributes no host-originated logical state that is not already
represented locally, so the join is unchanged. Two replicas with equal frontiers
therefore have equal logical merge state, even though their physical storage may
differ.

- If the local frontier dominates the staged frontier, the staged snapshot
  contains no host-originated logical contribution that is new to the local
  replica. The synchronization attempt MUST be a **complete no-op**: no
  destination is constructed, no journal entry is appended or repositioned, no
  notification is emitted, the watermark is not increased, no new provenance is
  published, and the active-replica pointer MUST remain unchanged.
- If the staged frontier contains a later comparable coordinate for at least one
  hostname, synchronization may proceed with a normal per-host merge.
- If the frontiers contain a coordinate whose `HostInstanceId` differs for the
  same hostname (unrelated storage reinitialization), synchronization MUST
  reject the input as an administrative conflict rather than choose arbitrarily.

### Absorption property

If the local frontier dominates a staged snapshot's frontier, incorporating the
staged snapshot changes nothing. Let `D = merge(A, B)`; if a subsequent staged
snapshot `S` is dominated by `D`'s frontier, then:

```
merge(D, S) = D
```

Equality here covers the complete installed result:

- graph state;
- journal entries and journal absences;
- `last_journal_index`;
- `SourceSnapshotProvenance` (including `causalFrontier`);
- notification behavior;
- the replica-switch decision.

The repeated synchronization must not append or reposition an event, increase
the watermark, publish new provenance, notify consumers again, or switch the
active replica. This is the property periodic synchronization relies on:
repeatedly synchronizing with hosts that have no new logical contribution cannot
keep churning the journal.

### No acknowledgement churn

Exporting or checkpointing a snapshot preserves all remote frontier entries. It
updates the local hostname's coordinate only if the host has actually originated
new logical graph or journal state since the prior exported snapshot. Learning
that another host has advanced, persisting a frontier acknowledgement, merging an
unchanged remote snapshot, compaction that is observationally invisible,
switching active replica slots, reopening storage, and transport activity do not
advance the local host's `HostStateVersion`. A frontier-only acknowledgement
must not advance the local coordinate. This rule prevents two periodically
synchronizing hosts from generating an endless sequence of acknowledgements
about acknowledgements.

A remote host becomes a genuine new input only when its coordinate advances to a
later logical version (within the same storage instance) not yet recorded in the
local frontier.

---

## Symmetric notification delta

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
state relative to either source. This ensures notification coverage for process
cursors that have been following either source.

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
- A retained journal event does not determine current graph state.
- It is valid for the latest retained journal event to describe an older state
  than the current final graph.

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

Synchronization may newly originate only sync-derived entries: a
`SyncDeleteJournalEntry` or a `SyncInvalidateJournalEntry`. It never originates
`add`, `edit`, or `validate`. All predicates below are independent of source
ordering.

#### Generated `delete`

Generate one `SyncDeleteJournalEntry` for semantic key `K` exactly when:

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

Generate one `SyncInvalidateJournalEntry` for semantic key `K` exactly when:

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

Because a sync-derived event's `eventId` is determined by the merge protocol
version, the canonical source-snapshot IDs, the action, and the key, the
generated identity is stable across both merge directions and across hosts. An
existing event that is already a sync-derived event from the same source
snapshots under the same protocol shares that `eventId`.

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
creator  = makeSync(causalFrontierHostnames(mergedFrontier))
```

`mergedFrontier` is
`unionCausalFrontiers(A.provenance.causalFrontier,
B.provenance.causalFrontier)`: the creator is the set of contributing
source hosts represented by the merged frontier, canonically ordered (see
`incremental-graph-journal-types.md`). It does not identify one host as the
actor, and it is not necessarily just the two hosts involved in the latest
exchange.

After the source snapshots, action, and key are fixed, assign the sync event
ID:

```js
const [lowerId, upperId] = canonicalPair([
    logicalSnapshotIdToString(A.provenance.id),
    logicalSnapshotIdToString(B.provenance.id),
])

JSON.stringify([
    "sync-v2",
    graphAndJournalMergeProtocolVersion,
    lowerId,
    upperId,
    action,
    nodeKeyToString(key),
])
```

No special sync event type or alternate ID format. The merge protocol version
is the protocol under which the merge produced the event (see
`incremental-graph-journal-types.md` § LogicalSnapshotId); two different
protocols producing different sync events for the same snapshots receive
different event IDs. The event ID embeds only exact logical snapshot identities
and never the physical journal placement allocated by the merge.

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

### Synchronization normalization

Steps 7 through 9 collectively form the **synchronization-normalization
phase**: the journal-reconciliation phase that turns the two source prefixes
into the physically canonical destination journal. This phase is the only
synchronization operation authorized to turn an established `present` journal
position into `absent` (see the global established-position invariant in
`incremental-graph-journal-types.md`). Its permitted deletions are exactly the
following five kinds:

1. **Same-index poisoning** (step 7): when two different established entries
   occupy the same index, both entries are removed and the position becomes
   absent.
2. **Established-absence propagation** (step 7): when one source has an
   established entry and the other has established absence at the same index,
   absence wins and the entry is removed.
3. **Logical-view pruning** (step 7): an established entry that is not part of
   the final canonical logical view — not the final canonical state or
   freshness event for its semantic key — is removed. This covers identical
   but noncanonical entries and noncanonical source-suffix entries.
4. **Duplicate occurrence normalization** (step 8): when the same `eventId`
   survives at several positions, every lower occurrence is removed, retaining
   the greatest position.
5. **Carrier repositioning** (step 9): the old physical occurrences of a
   selected notification carrier are removed before the carrier is freshly
   placed above `P`.

`logicalJournalView` is the canonical definition of which events are retained:
an entry is a legitimate synchronization-normalization deletion only when its
removal produces a destination whose physical journal equals its own
`logicalJournalView` (or moves a required canonical event above `P`). Every
deletion performed by the phase is one of the five kinds above. No other
established-position deletion is permitted by synchronization, and an operation
attempting an unclassified deletion of an established position is rejected by
this specification.

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
in step 6. The carrier must end with exactly one occurrence strictly above `P`.

- If `carrier` is a generated `SyncDeleteJournalEntry` or
  `SyncInvalidateJournalEntry` and has no surviving positioned occurrence, it
  is already in `FreshPlacementSet` from generated-event assignment; it will be
  allocated above `P` in step 10.
- Otherwise `carrier` has a surviving positioned occurrence (it is an existing
  canonical event, or a previously derived sync event from the same snapshots).
  Remove every surviving old occurrence of that carrier and
  `enqueueFresh(carrier)`.

Every established occurrence in `A` is at an index `≤ aH ≤ P`, and every
established occurrence in `B` is at an index `≤ bH ≤ P`. Therefore, before
fresh placement, an existing source event cannot already have a surviving
occurrence strictly greater than `P`. A carrier with any surviving occurrence
is always freshly placed above `P`.

`enqueueFresh` remains idempotent by `eventId`, and the carrier is placed
exactly once above `P`.

This does not mean every canonical event is repositioned. Only the selected
notification carrier for keys in `SyncDelta` is forced above `P`.

The bound is `P = max(aH, bH)`, not the watermark of whichever source is
locally active. This guarantees notification coverage for process cursors that
have been following either source.

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

When an entry is removed by same-index poisoning or established-absence
propagation, if that entry is final canonical and has no other surviving
position, call `enqueueFresh(event)`. Otherwise do not queue it.

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
   finalization acquires the destination darkroom. The destination's
   `SourceSnapshotProvenance` is durably established before cutover.

6. **Do not mutate the source replicas** while constructing the destination.

7. **After all destination records, including the destination
   `SourceSnapshotProvenance`, are durable and internally consistent, acquire
   the destination/finalization darkroom.**

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

Journal reconciliation is pairwise commutative. For two valid merge inputs `A`
and `B`:

- `SyncDelta` is symmetric by definition;
- the generated-event predicates are symmetric;
- the frontier union is symmetric: `unionCausalFrontiers` produces the same
  merged frontier (or the same rejection) in either input order;
- the merge-basis join is symmetric: `joinMergeBasis(A, B)` and
  `joinMergeBasis(B, A)` produce the same basis (see
  `incremental-graph-synchronization.md` § Merge basis);
- sync creators, event IDs, timestamps, and identifier selection are derived
  symmetrically from logical snapshot provenance and source journal evidence;
- carrier placement is enforced above `P = max(aH, bH)`, which is symmetric;
- all fresh-placement ordering keys are symmetric.

Therefore `merge(A, B)` and `merge(B, A)` produce the same canonical journal,
the same logical snapshot identity, the same causal frontier, the same merge
basis, and the same fresh-placement sequence.

---

## Absorption (fixed point)

Synchronization is a fixed point for unchanged hosts. Let `D = merge(A, B)`. If
a staged logical snapshot `S`'s complete causal frontier is dominated by `D`'s
frontier, then `merge(D, S) = D`. The dominance check covers every hostname in
`S`'s frontier, not merely the host that supplied the snapshot.

The repeated merge must not:

- append a journal event;
- reposition an existing journal event;
- notify consumers again (no new notification, no fresh placement above `P`);
- increase `last_journal_index`;
- publish new provenance (the `SourceSnapshotProvenance`, including the causal
  frontier, is unchanged);
- switch the active replica.

This is not merely idempotence for "the same two exact snapshots". The
absorption property is what periodic synchronization relies on: after `A` has
incorporated the logical contributions of `B`, re-synchronizing with any staged
snapshot whose frontier is already dominated is a complete no-op, even though
the local source is now the derived merge `D`, not the original snapshot `A`.
Ordinary local graph activity preserves remote frontier entries, so it does not
make an unchanged remote host "new"; only a later logical version within the
same storage instance does.

Do not query previous journal events to determine absorption. The no-op
decision comes from the persisted causal frontier before any journal
reconciliation runs.

---

## Interaction with compaction

Synchronization operates on each source's `logicalJournalView` at sync time. A
conforming physical compaction may have removed entries outside that view, but
it preserves every entry inside it, so source event selection is identical
before and after compaction.

Graph synchronization does not read journal state, so compaction cannot affect
graph synchronization correctness.

Compaction and the synchronization-normalization phase are the only two
operations authorized to delete established journal entries (see the global
established-position invariant in `incremental-graph-journal-types.md` and
`incremental-graph-journal-compaction.md`). Compaction performs logical-view
pruning — removing entries outside `logicalJournalView(journal, H)`. The
synchronization-normalization phase performs the five deletion kinds defined in
§ Synchronization normalization, one of which is the same logical-view pruning
applied to the reconciled destination. The operations remain distinct:
compaction never repositions or reappends events, and synchronization
normalization never runs as a storage-quota operation.

---

## Host identity and the public API

The public `PossibleNodeChange` fields are exactly `nodeName`, `bindings`,
`action`, and `time`. Host identities (`Hostname` values), sync creator sets
(`Sync` values), logical snapshot identities (`LogicalSnapshotId` values),
causal frontiers, merge-basis candidates, and raw journal indices
(`JournalIndex` values) are journal-internal and not part of the public API. The
`PossibleNodeChange` type intentionally excludes them.

---

## Testable scenarios

### T1 — Journal integrity: conflicting payload

Source A: eventId "[\"host\",\"h1\",\"instance-1\",3]" with payload edit W1
Source B: eventId "[\"host\",\"h1\",\"instance-1\",3]" with payload edit W2

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
generated-delete predicate and emits a `delete`, so the transition away from
the materializing source is covered by notification.)

### T7 — Identifier replacement emits no add or delete

A: K1 materializes K
B: K2 materializes K
F: K materialized (identifier-only replacement, equal value and freshness)

No delete, no add, no invalidate (unless freshness also changed). If freshness
changed up-to-date → stale, emit one invalidate using the final identifier.

### T8 — Repeated sync emits nothing new

First sync: A up-to-date, B stale, F stale, emits invalidate(K).

If the same two exact logical snapshots were reconciled again (a case the
causal-frontier gate of § Absorption (fixed point) normally prevents, because
the local source has advanced to the derived merge `D`), the same invalidate is
generated again with the same eventId; placement deduplicates and no second
logical event is created. In normal operation, re-synchronizing with unchanged
B after the first merge is a complete no-op (T34); this scenario documents the
internal emission-deduplication property that holds independently of that
no-op.

### T9 — Freshness history independent of state identifier

Source A: state = edit W1, freshness = invalidate W2
Source B: state = edit W1, freshness = invalidate W2

The canonical freshness event `invalidate W2` is retained even though
W2 !== W1. No filtering by identifier.

### T10 — Notification repositioning

Key K is in SyncDelta. `aH = 3`, `bH = 4`, so `P = 4`. The canonical state event
was at position 3. It is repositioned to position 6 (above P), so the
notification is placed strictly after the bound.

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

```
aH = 3
bH = 3
P  = 3

A[3] = canonical event E
B[3] = conflicting event F
```

`E` is also the selected notification carrier for a `SyncDelta` key `K`.

1. Step 7 (prefix merge): same-index poisoning removes both occurrences at
   index 3.
2. Step 8 (canonical-occurrence normalization): no surviving occurrence of `E`,
   so `enqueueFresh(E)`.
3. Step 9 (notification-bound enforcement): `E` is the carrier and has no
   surviving position, so `enqueueFresh(E)`.
4. `FreshPlacementSet` contains `E` only once because it is keyed by `eventId`.
5. `E` receives exactly one new position above `P`.

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

Host A and host B independently reconcile the same source snapshots at different
wall-clock times. The generated journal results must still be identical. Local
synchronization execution time must not enter the event payload or event ID.

### T19 — Repeated reconciliation

If the same two exact logical snapshots are reconciled a second time (a case the
causal-frontier gate normally prevents in per-host synchronization), a
regenerated sync event has the same eventId as the first and deduplicates
against any surviving occurrence, so no second logical sync event with a
different identity is created. This is an internal event-identity property; the
operational fixed point is the absorption property (PROP-JS-04a).

### T20 — New logical snapshots

A later pair of logical snapshots with different exact state may generate a new
event because the `LogicalSnapshotId`s differ, and therefore the sync event ID
differs.

### T21 — A merge output receives the exact-state identity

Merging logical snapshots `A` and `B` produces a destination whose
`SourceSnapshotProvenance.id` is the `LogicalSnapshotId` of the merged exact
logical state (see `incremental-graph-journal-types.md` § Logical snapshot
identity). The identity is a deterministic digest of the logical state — graph
projection, merge basis, logical journal view, causal frontier, schema version,
and merge protocol version — and never encodes how the state was produced or
transported, nor physical journal placement.

### T22 — Derived snapshot becomes a later merge input

After the first per-host merge, the derived output becomes the local source for
a second per-host merge. Its identity is the `LogicalSnapshotId` of its exact
logical state.

### T23 — Second merge generates a deterministic sync event ID

The second merge (derived snapshot `D` plus a new logical snapshot `C`)
generates a sync event whose ID is:

```
["sync-v2", graphAndJournalMergeProtocolVersion,
 logicalSnapshotIdToString(lower), logicalSnapshotIdToString(upper),
 action, nodeKeyToString(key)]
```

where `lower` and `upper` are `D.provenance.id` and `C.provenance.id` sorted by
`canonicalPair`, and the protocol version is the version under which the second
merge ran.

### T24 — Reversal produces the same snapshot identity

Merging `A` with `B` and merging `B` with `A` produce the same exact logical
state and therefore the same `LogicalSnapshotId`, because the frontier union,
the merge-basis join, and the canonical digest are all commutative.

### T25 — Distinct logical states do not share an ID

Two different synchronization-relevant logical states do not share one
`LogicalSnapshotId`, even when they reside on the same physical host or are
transported by the same adapter.

### T26 — Contributor sets union across successive merges

Freshly initialized leaf snapshots `A`, `B`, and `C` begin at version 0 and
have frontiers `{ A: { IA, 0 } }`, `{ B: { IB, 0 } }`, and `{ C: { IC, 0 } }`.
Merging `A` and `B` yields a frontier `{ A: { IA, 0 }, B: { IB, 0 } }` and a
contributor set `Sync{A, B}` (derived from the frontier's hostnames). Merging
that derived snapshot with leaf `C` yields a frontier with hostnames `{A, B, C}`
and a contributor set `Sync{A, B, C}`. The contributor set is never stored
independently of the frontier.

### T27 — HostInstanceId is stable across reset and cutover

The local `HostInstanceId` is generated only at storage-instance initialization
and is unchanged by reset, migration, synchronization, compaction, and replica
cutover. Two unrelated reinitializations of the same hostname produce different
`HostInstanceId`s, which is an administrative conflict when synchronized.

### T28 — Sync event ID carries no physical index

A `SyncDeleteJournalEntry` or `SyncInvalidateJournalEntry` event ID is derived
from the merge protocol version, the exact source-snapshot identities, the
action, and the key. The embedded snapshot identities are fixed-size digests of
the logical state. The event ID does not depend on the destination physical
journal index, compaction layout, or carrier positions.

### T29 — Local activity invalidates source provenance

After a merge produces derived snapshot `D`, ordinary local `pull` or
`invalidate` activity mutates the graph and journal. The stored provenance no
longer describes the exact local state. A second synchronization run begins by
freezing/exporting the exact local source and deriving fresh provenance for
that precise logical snapshot, so the second run's local source snapshot ID
differs from `D`'s. The export derives its frontier with
`localExportCausalFrontier`: remote entries are preserved and only the local
hostname's coordinate is updated, advancing it only when the host actually
originated new logical state (its version within its current instance).

### T30 — Host instance disambiguates unrelated reinitialization

Host A's storage instance `IA1` contains `eventId = ["host","A","IA1",21]`. A
later reinitialization of host A creates a new storage instance `IA2`; after
eleven appends the new instance reaches index 21 with
`eventId = ["host","A","IA2",21]`. The two event IDs differ, so synchronization
cannot confuse the two payloads. Reused numeric journal indices cannot collide
because the instance identity is part of the event ID. The same `IA2` value also
appears in A's frontier coordinate `{ A: { IA2, 0 } }`, so event identity and
frontier coordinates share one canonical instance representation.

### T31 — Two-host periodic fixed point

Two hosts A and B start fresh at version 0: A's frontier is `{ A: { IA, 0 } }`
and B's is `{ B: { IB, 0 } }`.

1. A exports its snapshot and B stages it. B's frontier `{ B: { IB, 0 } }` does
   not dominate the staged frontier `{ A: { IA, 0 } }`, so B merges A and its
   frontier becomes `{ A: { IA, 0 }, B: { IB, 0 } }`.
2. B exports its snapshot and A stages it. A's frontier does not dominate, so A
   merges B and its frontier becomes `{ A: { IA, 0 }, B: { IB, 0 } }`.
3. Each host exports its current state. Exporting the newly learned frontier
   does not advance A or B's own logical version: both remain `IA/0` and `IB/0`.
4. They exchange snapshots again. Each local frontier now dominates the staged
   frontier (`{ A: { IA, 0 }, B: { IB, 0 } }` in both directions), so both
   synchronization attempts are complete no-ops: no destination is constructed,
   no journal entry is appended or repositioned, no notification is emitted,
   the watermark is unchanged, no provenance is published, and no replica is
   switched.
5. Repeating the periodic process indefinitely produces no new journal
   placement, provenance, watermark, snapshot content, or replica switch.

### T32 — Local pulls do not re-incorporate unchanged B

After the fixed point above (`{ A: { IA, 0 }, B: { IB, 0 } }`), host A performs
ordinary local pulls and invalidations and exports again. The export preserves
`{ B: { IB, 0 } }` and updates only A's own coordinate to `{ A: { IA, 1 } }`
(A originated new content in one transaction, so its version advances exactly
once). B stages A's export: B's frontier `{ A: { IA, 0 }, B: { IB, 0 } }` does
not dominate (A is now `IA/1`), so B merges A exactly once. B exports (frontier
`{ A: { IA, 1 }, B: { IB, 0 } }`); A stages it, A's frontier dominates, and the
merge is a no-op. Unchanged B was not re-incorporated; A's new contribution
propagated exactly once.

### T33 — Real change on B propagates exactly once

The system is at the fixed point `{ A: { IA, 1 }, B: { IB, 1 } }`. B performs a
real host-local graph or journal mutation and advances its own version to
`IB/2`. B exports a snapshot with frontier `{ A: { IA, 1 }, B: { IB, 2 } }`. A
stages it; A's frontier `{ A: { IA, 1 }, B: { IB, 1 } }` does not dominate
(B is later), so A merges B exactly once, and A's frontier becomes
`{ A: { IA, 1 }, B: { IB, 2 } }`. Subsequent periodic exchanges are again
complete no-ops.

### T34 — Regression and administrative conflict are rejected

- If host B's coordinate regresses within the same storage instance — the staged
  version is earlier than the incorporated version — normal synchronization
  rejects the merge.
- If a staged snapshot carries a coordinate for a hostname whose `HostInstanceId`
  differs from the recorded instance, the two coordinates represent unrelated
  storage reinitialization; normal synchronization rejects the input as an
  administrative conflict rather than choosing or ordering.

### T35 — Reversed sources produce the same frontier and merge basis

`unionCausalFrontiers(Fa, Fb)` and `unionCausalFrontiers(Fb, Fa)` produce the
same frontier (or the same rejection), and `joinMergeBasis(A, B)` and
`joinMergeBasis(B, A)` produce the same merge basis. Therefore `merge(A, B)` and
`merge(B, A)` record the same causal frontier, the same merge basis, and the
same contributor set.

### T39 — Identical noncanonical entries at the same index

Sources A and B both have an identical non-final-canonical entry `E` at the
same index `i`. Step 7 preserves an entry at `i` only when it is final
canonical, so `E` is pruned by logical-view pruning and `i` becomes absent.

### T40 — Noncanonical source suffix is pruned

Host B's suffix positions above `aH` contain entries that are not final
canonical. Step 7 case 3 preserves a B entry only when it is final canonical;
every noncanonical suffix entry is pruned and its position becomes an
established absence.

### T41 — Duplicate occurrences of one eventId

A final canonical event `E` survives at positions 3 and 8 in the destination
prefix. Step 8 retains position 8 and makes position 3 absent. No fresh copy is
created because a later surviving copy exists.

### T42 — Carrier removal and fresh placement

Key K is in `SyncDelta` and its canonical state event `E` is the selected
carrier at position 5 with `P = 5`. Step 9 removes the old occurrence at
position 5 and enqueues `E` for fresh placement; `E` receives exactly one new
occurrence above `P` in step 10, preserving its original `eventId`.

### T43 — Unclassified established-position deletion is rejected

Synchronization has no authority to delete an established entry outside the
synchronization-normalization phase's five permitted kinds. An operation that
attempts, for example, to replace an established entry, fill an established
absence, or delete an established entry for reasons other than the five kinds
is rejected by this specification.

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

**PROP-JS-04 (Sync emission idempotence):** A regenerated sync-derived event for
the same logical snapshots under the same protocol has an identical eventId and
is deduplicated; no second logical sync event is created by the same two exact
logical snapshots.

**PROP-JS-04a (Absorption / fixed point):** Let `D = merge(A, B)`. If a staged
logical snapshot `S`'s complete causal frontier is dominated by `D`'s frontier,
then `merge(D, S) = D`: the graph state, journal entries and absences,
`last_journal_index`, `SourceSnapshotProvenance`, notification behavior, and
replica-switch decision are all unchanged. The repeated merge does not append
or reposition an event, increase the watermark, publish new provenance, notify
consumers again, or switch the active replica.

**PROP-JS-05 (Graph sync independence):** Graph synchronization correctness
does not depend on journal state, journal retention, or journal compaction.

**PROP-JS-06 (Pairwise commutativity):** `merge(A, B)` and `merge(B, A)` produce
the same canonical journal, the same fresh-placement sequence, the same exact
logical state and `LogicalSnapshotId`, the same causal frontier, and the same
merge basis.

**PROP-JS-07 (Deterministic sync events):** Sync-derived events depend only on
the exact logical snapshots and the source journal evidence. They do not depend
on which source is locally active, on the host executing reconciliation, on the
wall-clock time of merge execution, or on any transport revision or storage
location.

**PROP-JS-08 (Deletion taxonomy closed):** Synchronization deletes an
established journal entry only through the synchronization-normalization phase
and only for one of its five permitted kinds: same-index poisoning,
established-absence propagation, logical-view pruning, duplicate occurrence
normalization, or carrier repositioning. Any other deletion of an established
entry is rejected by this specification.
