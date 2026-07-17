# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how journal state is reconciled during synchronization between hosts. Synchronization produces one complete merged inactive replica, which replaces the active replica only after it is durable and complete.

Synchronization does **not** create new logical journal events. It works only with journal events that were already emitted by ordinary graph operations, migration operations, freshness transitions, and actual node deletion operations.

---

## Core conflict resolution

Physical compaction may already have removed every event outside the logical journal view. Therefore synchronization MUST NOT depend on raw physical entries that logical compaction would reject.

For each source replica and semantic node key, synchronization uses only the source's entries from `logicalJournalView(journal, last_journal_index)`:

- the source's latest state entry (`add`, `edit`, or `delete`) — the greatest-index entry in the state/lifecycle category;
- the source's latest freshness entry (`invalidate` or `validate`) — the greatest-index entry in the freshness category.

Older physically present entries are redundant and must not affect graph conflict resolution, deletion conflict resolution, freshness conflict resolution, evidence preservation, or fresh reappend decisions.

### Source consistency

REQ-JS-00: For a materialized source node with identifier `W`, the source's latest state entry MUST be `add` or `edit`, and its `id` MUST equal `W`.

For a deleted source key with retained journal history, the latest state entry MUST be `delete`.

If graph state and latest state evidence contradict one another, synchronization fails with a journal-integrity error and leaves the active replica unchanged.

Synchronization MUST NOT substitute graph timestamp records for missing or contradictory journal evidence.

### State conflict comparison

Compare the two source latest-state entries:

1. later `time` wins;
2. if identifiers differ and times tie, lexicographically greater `NodeIdentifier` wins;
3. if identifiers are equal and times tie, lexicographically greater `eventId` (string comparison) wins.

The winner determines:
- materialized value/incarnation (the winning `add` or `edit`); or
- deletion (the winning `delete`).

Synchronization creates no new event. It preserves or reappends the existing winning event.

REQ-JS-01: When synchronizing two hosts, for each node key that appears in both replicas' graph state, the host whose latest state entry has the later `time` field wins the conflict. The winning host's value is retained; the losing identifier and associated records are removed.

REQ-JS-02: If both hosts have the same `time` for the conflicting latest state entry, tie-breaking is decided via lexicographic comparison of `NodeIdentifier` (converted to string) when identifiers differ. `NodeIdentifier` values are globally unique across hosts, making this a total deterministic tie-breaker. When identifiers are equal, lexicographically greater `eventId` wins.

### Wall-clock resolution

A particular host's wall clock may be incorrect, but this is the best available signal for conflict ordering — the system trusts hosts and does not rely on external time authorities.

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

### Published-prefix invariant

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
   | entry E | entry E | preserve E at i |
   | absent | absent | preserve absence at i |
   | entry E | absent | absence at i (see evidence preservation) |
   | absent | entry E | absence at i (see evidence preservation) |
   | entry E | entry F (E ≠ F) | poison: absence at i; queue E and F for fresh reappend |

2. **Only local has established state at `i`** (i ≤ localH, i > remoteH):
   Preserve the local state (entry or absence) at `i` in the destination.

3. **Only remote has established state at `i`** (i > localH, i ≤ remoteH):
   The position is unestablished locally. Replicate the remote state at `i` (copy the remote entry, or establish absence when the remote position is absent).

The entire prefix state through `P` is resolved before fresh entries are allocated.

### Fresh entry allocation

Displaced entries (from poisoning or absence propagation) and evidence that cannot retain its original position are allocated at:

```
P + 1 .. P + n
```

The final watermark is `P + n`.

### Fresh entry ordering

Fresh entries are ordered by:

1. `time` ascending;
2. `NodeKeyString` ascending;
3. `creator` ascending;
4. Action rank: `add < edit < delete < invalidate < validate`;
5. `NodeIdentifier` ascending.

`NodeIdentifier` values are globally and historically unique. Do not add any further criterion after `NodeIdentifier`.

Allocate the ordered entries contiguously at `P + 1 .. P + n`.

### Deduplication

If the same `eventId` survives at several physical positions in the merged destination:
- retain the occurrence with the greatest `JournalIndex`;
- make all lower occurrences absent;
- do not create another fresh copy.

An unpositioned event queued for fresh placement does not participate in the "greatest position" comparison.

If the same event already survives at a positioned target entry, remove its queued fresh copy.

### Destination logical view canonicalization

REQ-JS-07: After physical index reconciliation, the destination's `logicalJournalView(journal, P + n)` must contain exactly:

- the canonical state event for each key;
- the canonical freshness event for each key, when one exists.

The canonical event may already occupy the greatest surviving index in its category. If it does not — for example, an obsolete event for the same key and category survives at a greater physical index in the merged prefix — reappend the canonical existing event at a fresh index above `P` (see fresh entry allocation). Preserve its exact action, key, identifier, time, creator, and `eventId`. This makes the canonical event the greatest-index event in its category.

Older redundant entries may remain physically present until separate compaction. They are invisible through `possibleMaybeChanges`.

Synchronization still does not create any logical event.

#### Required displaced evidence

REQ-JS-08: If physical reconciliation displaces a canonical event because of same-index poisoning or entry-versus-established-absence, reappend it freshly. This applies to canonical state evidence and canonical freshness evidence.

Do not reappend obsolete noncanonical events.

---

## Value evidence

REQ-JS-09: For conflicting materialized values, compare the two source latest-state entries (from `logicalJournalView` for each source) using the state conflict comparison rules defined in §State conflict comparison. Use the winning graph state. Preserve or reappend the existing causal events as required. Do not generate an additional event.

For deletion conflict:

REQ-JS-10: Compare the surviving `delete` event against the latest surviving `add` or `edit` using the state conflict comparison rules. Preserve the winning existing evidence. Do not generate an additional event.

Synchronization must never use graph timestamp storage as replacement journal evidence.

---

## Freshness evidence reconciliation

Synchronization does not create freshness events. It reconciles existing `validate` and `invalidate` events using the same `logicalJournalView` per source replica.

Freshness belongs to a node incarnation identified by `NodeIdentifier`, not merely to a semantic key. After the canonical graph winner is determined (resolving value conflicts via the state conflict comparison rules), only freshness events matching the winning `NodeIdentifier` may determine the canonical node's freshness.

For each semantic node key whose canonical graph winner has `NodeIdentifier = W`:

1. For each source replica, the source's latest freshness entry for `W` is the greatest-index `validate` or `invalidate` with `id === W` from that source's `logicalJournalView`. If the source has no such event, use the selected graph state's existing freshness (first materialization without a freshness event means up-to-date).

2. If only one source has a candidate event for `W`, use it.

3. If both sources have candidate events for `W`, compare:
   1. `time`;
   2. `eventId` (lexicographic string comparison).

   Later time wins. If times tie, lexicographically greater `eventId` wins. `NodeIdentifier` is not used as a freshness tie-breaker here because both candidates are already restricted to `W`, making the identifiers equal.

4. The canonical graph freshness follows the winning event:
   - winning `invalidate`: `potentially-outdated`
   - winning `validate`: `up-to-date`

5. In the merged journal destination, preserve exactly one surviving freshness event for `W`: the winner.

6. Make every other surviving `validate` or `invalidate` entry for `W` absent.

7. Remove freshness events for losing node identifiers as obsolete (unless another explicit retention rule requires them — no such rule is currently specified).

8. If the winner cannot remain at its old numeric position because of physical-position reconciliation, reappend the same existing event at a fresh index.

9. Preserve its `eventId`.

### Deleted canonical key

When the canonical graph has no materialized node for the key, no freshness event sets graph state (there is no materialized graph freshness to set). The journal retains the latest freshness entry from `logicalJournalView` when one exists. The retained history does not make the deleted node up-to-date or potentially-outdated.

This guarantees that:
- the merged graph freshness matches the journal;
- compaction has one required freshness event to retain;
- `possibleMaybeChanges` returns the canonical freshness transition;
- freshness events belonging to losing or obsolete node identifiers cannot affect the winning node's freshness.

### Interaction with physical merge

Run physical position reconciliation first. Then scope freshness normalization to the winning `NodeIdentifier`. The final destination must satisfy both per-position convergence rules and exactly one surviving canonical `validate` or `invalidate` event per winning-identifier incarnation when freshness evidence exists.

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

If the two source replicas have different `JournalEntry` values at the same `JournalIndex` `i`, the destination poisons that index. Both conflicting entries are deleted from index `i` in the destination. Any still-relevant changes described by the conflicting entries are appended at fresh `JournalIndex` values above `P`.

### Present-versus-absence conflict

If one source replica has an established journal entry at index `i` and the other has an established absence at the same index `i`, the destination establishes absence at index `i`. The present entry is removed in the destination.

If the removed entry still carries relevant journal evidence (it is the only surviving `add` or `edit` for a materialized node), that evidence is reappended at a fresh index before or atomically with removing the established entry from the destination.

### Remote suffix

A remote suffix position `i` (where `localH < i ≤ remoteH`) MAY be replicated at local position `i` in the destination while `i` is unestablished locally. If the position became established locally before sync finalization, sync reconciles the local and remote states at `i` using the same-index convergence rules.

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

Sync operates on the journal storage that exists at sync time. Compaction may have removed entries before sync.

Sync uses only surviving journal entries for conflict comparison. Absent journal entries are treated as "no journal evidence" — sync MUST NOT fall back to graph `timestamps` sublevel as a replacement for missing journal entries.

Compaction MUST NOT remove the only surviving `add` or `edit` entry for a materialized node (see REQ-JC-07). This ensures sync always has at least one journal-backed timestamp per materialized node for conflict comparison.

---

## Host identity and journal consumers

Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Sync order

Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. `JournalIndex` order is not a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule.

---

## Testable scenarios

### T1 — Remote suffix preserved at same index (no race)

```
local H = 5
remote H = 6, remote[6] = E

sync constructs inactive destination
index 6 is unestablished locally (6 > 5)
sync replicates E at index 6 in the inactive destination
sync commits H = 6
```

The remote entry is preserved at its original numeric position because it was unestablished locally.

### T2 — Pre-sync append (before holidayActivity)

```
local H = 5

An ordinary append commits F at index 6:
    local H = 6

Sync then acquires holidayActivity and selects the source:
    local[6] = F
    local H = 6

remote H = 6, remote[6] = E

Sync constructs the inactive destination:
    index 6 is a same-index conflict (F vs E)
    target[6] = absent (poisoned)
    F and E are reappended at indices 7 and 8
    H = 8
```

This is a pre-synchronization append, not an operation overlapping
synchronization. After holidayActivity is held, no further ordinary
appends can occur until synchronization completes.

### T3 — Present-versus-absent propagation

```
Host A: index 5 = E
Host B: index 5 = absent (compacted)
```

Absence wins at index 5. E is reappended at index 6 if still relevant evidence.

### T4 — Sparse remote suffix

```
Local H = 5
Remote H = 100, indices 6..99 absent, index 100 = E
```

Canonical prefix: indices 6..99 = absence, index 100 = E, H = 100.

### T5 — Fresh entry ordering

Two displaced entries: E1 (time=100) and E2 (time=200). Order by time ascending, then by the other canonical fields. Assign contiguous positions above P.

### T6 — Duplicate event at several retained positions

```
index 3 = event X (eventId = "...")
index 8 = event X (eventId = "...")
```

Canonical result: index 3 = absent, index 8 = event X. The greatest position survives.

### T7 — Event ID integrity violation

```
Host A: eventId X with payload E
Host B: eventId X with payload F (different)
```

Synchronization fails with integrity error. No journal or graph mutation is committed. The entries are not poisoned or deduplicated.

### T8 — No synthetic sync event

A remote edit wins graph conflict. The destination preserves or reappends the original remote edit event. The number of logical events does not increase merely because synchronization occurred.

### T9 — Sync freshness conflict (winning identifier)

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

### T10 — Replica-switch failure

Synchronization fails while constructing the inactive destination. The old active replica remains selected. The old active graph and journal remain unchanged. The incomplete inactive destination is never visible.

### T11 — Replica cutover

After the inactive destination is complete:
- `closeGarden` prevents readers from selecting a replica during cutover;
- the active pointer switches;
- later readers select only the new replica.

### T12 — Synchronization canonical state

One source's latest state entry is `edit E`; the other's is `edit F`. The conflict winner is E (later time, or tie-breaker). If F remains at a physically greater index in the merged prefix, synchronization reappends E above `P`. The destination logical view returns E, not F.

### T13 — Canonical freshness displaced by absence

The winning `validate` event is physically displaced during reconciliation (the source that provides it has established absence at that index on the other side). The destination reappends that same event above `P`, preserving its `eventId`.

### T14 — No obsolete reappend

An older noncanonical `edit` event for a key is displaced during physical reconciliation (e.g., its position is poisoned). It is NOT reappended merely because it existed. Only canonical state and canonical freshness events are preserved.
