# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how journal state is reconciled during synchronization between hosts. Synchronization produces one complete merged inactive replica, which replaces the active replica only after it is durable and complete.

Synchronization does **not** create new logical journal events. It works only with journal events that were already emitted by ordinary graph operations, migration operations, freshness transitions, and actual node deletion operations.

---

## Core conflict resolution

When synchronizing two hosts, for each node key that appears in both replicas' graph state:

REQ-JS-01: The host whose journal entry has the later `time` field wins the conflict. The winning host's value is retained; the losing identifier and associated records are removed.

REQ-JS-02: If both hosts have the same `time` for the conflicting node, tie-breaking is decided via lexicographic comparison of `NodeIdentifier` (converted to string). `NodeIdentifier` values are globally unique across hosts, making this a total deterministic tie-breaker.

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

The merge operates on two replica revisions. For the local replica, the established prefix through its committed watermark is finalized. For the remote replica, its established prefix through its committed watermark is finalized.

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

---

## Value evidence

For conflicting materialized values:
1. Compare the latest relevant `add` or `edit` entry time.
2. If tied, compare `NodeIdentifier`.
3. Use the winning graph state.
4. Preserve or reappend the existing causal events as required.
5. Do not generate an additional event.

For deletion conflict:
1. Compare the surviving `delete` event against the latest surviving `add` or `edit`.
2. Use time, then `NodeIdentifier`.
3. Preserve the winning existing evidence.
4. Do not generate an additional event.

Synchronization must never use graph timestamp storage as replacement journal evidence.

---

## Freshness evidence reconciliation

Synchronization does not create freshness events. It reconciles existing `validate` and `invalidate` events.

For each semantic node key:

1. Find the latest surviving freshness event from each source replica.

2. If only one source has freshness evidence, use it.

3. If both sources have freshness evidence, compare:
   1. `time`;
   2. `NodeIdentifier`.

   Later time wins. If times tie, the lexicographically greater globally unique `NodeIdentifier` wins.

4. The canonical graph freshness follows the winning event:
   - winning `invalidate`: `potentially-outdated`
   - winning `validate`: `up-to-date`

5. In the merged journal destination, preserve exactly one surviving freshness event for that semantic key: the winner.

6. Make every other surviving `validate` or `invalidate` entry for that key absent.

7. If the winner cannot remain at its old numeric position because of physical-position reconciliation, reappend the same existing event at a fresh index.

8. Preserve its `eventId`.

This guarantees that:
- the merged graph freshness matches the journal;
- compaction has one required freshness event to retain;
- `possibleMaybeChanges` returns the canonical freshness transition;
- a losing later-position freshness event cannot incorrectly override the winner merely because of physical index order.

### Interaction with physical merge

Run physical position reconciliation first, then normalize freshness events per semantic key. The final destination must satisfy both per-position convergence rules and exactly one surviving canonical `validate` or `invalidate` event per key when freshness evidence exists.

---

## Physical journal convergence

After synchronization completes, for every `JournalIndex` `i`, all synchronized hosts MUST agree that `rendered/r/journal/i` is either:
- the **same** `JournalEntry` value (byte-for-byte identical), or
- **absent** (compacted or deleted on that host).

What is NOT allowed is host A having one `JournalEntry` at index `i` while host B has a different `JournalEntry` at the same index `i`.

### Resolving divergent indices

If synchronization discovers that two hosts have different `JournalEntry` values at the same `JournalIndex` `i`, that index is poisoned. Both conflicting entries MUST be deleted from index `i`. Any still-relevant changes described by the conflicting entries MUST be appended at fresh `JournalIndex` values above `P`.

### Present-versus-absent conflict

If one synchronized host has an established journal entry at index `i` and another host has an established absence at the same index `i`, absence wins at index `i`. The present entry MUST be removed from index `i` on every host that has it.

If the removed entry still carries relevant journal evidence (it is the only surviving `add` or `edit` for a materialized node), that evidence MUST be reappended at a fresh index before or atomically with removing the established entry.

### Remote suffix

A remote suffix position `i` (where `localH < i ≤ remoteH`) MAY be replicated at local position `i` while `i` is unestablished locally. If the position became established locally before sync finalization, sync MUST reconcile the local and remote states at `i` using the same-index convergence rules.

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

### T2 — Remote suffix and concurrent append

```
local H = 5
remote H = 6, remote[6] = E

ordinary append commits F at local index 6, H becomes 6

sync detects index 6 is now established locally with F
sync treats index 6 as a same-index conflict (F vs E)
target[6] = absent (poisoned)
sync reappends F at index 7 and E at index 8
H = 8
```

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

### T9 — Sync freshness conflict

```
Host A latest freshness: invalidate X, time 100, id A1
Host B latest freshness: validate X, time 200, id B1
```

Merged inactive destination:
- X is up to date;
- only the `validate` event survives as freshness evidence;
- no new event is created.

### T10 — Replica-switch failure

Synchronization fails while constructing the inactive destination. The old active replica remains selected. The old active graph and journal remain unchanged. The incomplete inactive destination is never visible.

### T11 — Replica cutover

After the inactive destination is complete:
- `closeGarden` prevents readers from selecting a replica during cutover;
- the active pointer switches;
- later readers select only the new replica.
