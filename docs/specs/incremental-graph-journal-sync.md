# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how the journal participates in synchronization between hosts. Synchronization must reconcile graph state and journal state together so that graph-state reconciliation is visible through later journal queries.

---

## Core principles

1. **Graph and journal are reconciled together.** Sync does not treat graph state and journal state as independent concerns. A reconciliation that changes graph state must also make those changes visible through the journal.

2. **Timestamp-based conflict resolution.** For concurrent edits to the same semantic node key, the recorded entry with the later `time` field wins. If `time` produces a tie, the node with the lexicographically greater `JournalEntry.id` (`NodeIdentifier` converted to string) wins. `NodeIdentifier` values are globally unique across hosts (each identifier incorporates a host fingerprint and a monotonic allocation index) and historically unique, so this tie-breaker is total without needing an additional `creator` tie-breaker. Since `time` comes from host wall clocks, this is a last-writer-wins-by-recorded-wall-clock policy with deterministic tie-breakers.

3. **Wall-clock-based resolution.** A particular host's wall clock may be incorrect, but this is the best available signal for conflict ordering — the system trusts hosts and does not rely on external time authorities. The timestamp field is the entry's recorded local time, used as-is for conflict comparison.

---

## Conflict resolution

### Per-node-key resolution

When synchronizing two hosts, for each node key that appears in both hosts' graph state (potentially under different `NodeIdentifier` values in each host's allocation namespace):

REQ-JS-01: The host whose journal entry has the later `JournalEntry.time` wins the conflict. The winning host's value is retained; the losing host's identifier and associated records are removed or replaced.

REQ-JS-02: If both hosts have the same `time` for the conflicting node, tie-breaking is decided via lexicographic comparison of `JournalEntry.id` (`NodeIdentifier` converted to string). `NodeIdentifier` values are globally unique across hosts (host fingerprint + monotonic allocation index) and historically unique, making this a total deterministic tie-breaker.

This ensures deterministic resolution on all hosts.

### One canonical graph target

Synchronization computes one canonical graph target and one canonical journal target, not a host-relative resolution.

REQ-JS-03: For each conflicting node key, sync MUST determine the winning canonical graph state using timestamp and identifier tie-breaking (REQ-JS-01, REQ-JS-02). The loser's records (value, freshness, inputs, revdeps, counters, timestamps) are removed. A single canonical set of notifications is included in the journal target. The result must not depend on which replica is called "local."

The same canonical graph and journal target is applied to every participant before declaring convergence. Local application mechanics (how a host physically applies the target) are implementation-defined, but the canonical semantic resolution is independent of which host executes the merge.

### Deterministic sync-generated events

REQ-JS-04: For a pairwise reconciliation, every newly generated sync event is authored by the lexicographically smaller participating `Hostname`:

```
syncAuthor = lexicographically smaller participating Hostname
```

Every newly generated sync event in that canonical plan has:

```
creator = syncAuthor
eventId.creator = syncAuthor
```

This is independent of which host initiated the operation.

REQ-JS-05: For each generated event, `time` is set to the maximum `time` among its causal journal events (the `causes` array in `PendingSyncEventKey`):

- Remote value adoption uses the winning `add` or `edit` event time.
- Remote deletion uses the winning remote `delete` event time.
- Identifier-conflict delete and winner-edit use the maximum time among the winning and losing value-evidence events.

Every generated sync event MUST have at least one causal journal event. If the implementation reaches a case requiring a generated event but has no journal cause, it is a separate unsupported/no-evidence case — do not fall back to graph timestamps or wall clock.

REQ-JS-06: Generated events participate in canonical ordering using their `PendingSyncEventKey`. After positions are assigned, a generated event at position `i` receives:

```
eventId = {
    creator: syncAuthor,
    originIndex: i,
}
```

The same complete event bytes are then part of the canonical target applied to all participants.

---

## Journal entries produced by sync

REQ-JS-07: If synchronization changes canonical graph state, sync MUST make that change visible as a journal entry in the canonical target. Specifically:

- If a remote node value is adopted (its timestamp wins), an `edit` journal entry is included in the canonical target.
- If a remote node is newly materialized (first time seen), an `add` journal entry is included.
- If a node is removed because the remote deletion timestamp wins, a `delete` journal entry is included.
- If a losing `NodeIdentifier` is dematerialized by conflict resolution, a `delete` entry is included.

REQ-JS-08: Sync MUST NOT omit a journal entry that would be necessary for later `graph.possibleMaybeChanges` queries to observe a material graph change.

---

## Delete entries from conflict resolution

### Conflicting identifier allocation

REQ-JS-09: When two hosts independently allocate `NodeIdentifier` values for the same node key, one identifier loses based on timestamp and identifier tie-breaking (REQ-JS-01, REQ-JS-02). The canonical target includes:

- A `delete` entry for the losing identifier's node key (author: `syncAuthor`, time: max causal time, per REQ-JS-05).
- An `edit` entry for the winning identifier's value (author: `syncAuthor`, time: max causal time, per REQ-JS-05).

### Remote deletion

REQ-JS-10: If one host has a surviving `delete` journal entry for a node key that the other host has materialized:

- Compare the `delete` entry's `time` against the materialized node's latest surviving `add` or `edit` journal entry time.
- If the `delete` time is later, the deletion wins in the canonical target. A `delete` entry (author: `syncAuthor`, time: `delete` entry time) is included as a sync-generated event.
- If the latest `add` or `edit` entry time is later, the node is preserved in the canonical target. No `delete` is included.

---

## Journal storage during sync

REQ-JS-11: New journal entries appended during sync (conflict-resolution notifications) MUST receive fresh `JournalIndex` values. These are allocated from the local watermark and appended at the current head of the journal.

REQ-JS-12: After sync, the local `last_journal_index` MUST be advanced to cover the maximum of the pre-sync local value, the pre-sync remote value, and any freshly allocated indices. This ensures the watermark reflects all indices present on any synchronized host.

---

## Physical journal convergence

Synchronization must bring journal storage into physical agreement.

### The canonical merge function

The pairwise journal reconciliation is defined as a function:

```
canonicalMerge(A, B)
```

It takes:
- two fixed committed replica states (A and B);
- their stable host identities.

It does not read:
- current wall clock;
- caller direction;
- host-relative "local" authorship;
- mutable remote state.

The output is:
- canonical graph target (for every conflicting node key, the winning graph state);
- canonical journal prefix (for every numeric position through P, the resolved state);
- canonical fresh event list (deterministically ordered);
- final watermark (P + n).

REQ-JS-13a: `canonicalMerge` MUST be deterministic, symmetric, and commutative:

```
canonicalMerge(A, B) = canonicalMerge(B, A)
```

REQ-JS-13b: `canonicalMerge` MUST be idempotent for already-converged inputs:

```
canonicalMerge(T, T) = T
```

where `T` is an already converged target. Merging the already converged target with itself creates no new sync event, no new journal index, and no watermark change.

### Partial canonical-target application

Before any participant exposes a canonical target, the target MUST be fixed completely, including: prefix states, fresh-event ordering, fresh positions, generated event payloads, generated event IDs, and final watermark.

REQ-JS-13c: Once any participant has committed that target, retry MUST reuse the exact same target. It MUST NOT regenerate sync events with different times, creators, IDs, or positions. Recomputation is permitted only if no participant has yet committed the old target.

REQ-JS-13d: A synchronization session is complete only when all participants have applied that target. If one participant applies it and another does not, synchronization is incomplete. If a participant performs a new ordinary append after applying the target, that append is post-plan activity and belongs to a later reconciliation; the prior session cannot claim full current-state convergence beyond its fixed frontier.

REQ-JS-13: After synchronization completes, for every `JournalIndex` `i`, all synchronized hosts MUST agree that `rendered/r/journal/i` is either:

- the **same** `JournalEntry` value (byte-for-byte identical), or
- **absent** (compacted or deleted on that host).

What is NOT allowed is host A having one `JournalEntry` at index `i` while host B has a different `JournalEntry` at the same index `i`. The unified merge algorithm (above) computes the canonical target state that resolves all conflicts deterministically.

### Resolving divergent indices

REQ-JS-14: If synchronization discovers that two hosts have different `JournalEntry` values at the same `JournalIndex` `i`, that index is poisoned. Both conflicting entries MUST be deleted from index `i`. Any still-relevant changes described by the conflicting entries MUST be appended at fresh `JournalIndex` values above the unified merge frontier `P`:

```
P = max(
    revalidated local last_journal_index,
    fixed remote last_journal_index
)
```

All newly generated and reappended entries MUST receive indices `P + 1 .. P + n`. This ensures that reappended entries cannot collide with any established position because every numeric position through `P` is resolved by the prefix merge.

If both conflicting entries describe changes to the same node key, the re-appended entries are distinct `PossibleNodeChange` values for that key at different journal indices. This is a direct consequence of the poisoning rule: each conflicting entry that carried a still-relevant change produces its own re-appended entry.

This rule avoids the risk that choosing one authoritative entry to remain at the poisoned index would make a caller using a previous `since` value skip a change it has not observed.

### Present-versus-absent conflict

REQ-JS-15: If one synchronized host has an established journal entry at index `i` and another host has an established absence at the same index `i`, absence wins at index `i`. The present entry MUST be removed from index `i` on every host that has it. Absence at an established index may be caused by compaction, poisoning, propagated remote compaction, or any other structural deletion.

If the removed entry still carries relevant journal evidence (i.e., it is the only surviving `add` or `edit` for a materialized node key), that evidence MUST be reappended at a fresh local index before or atomically with removing the established entry. This ensures that compaction evidence rules (REQ-JC-07) and materialized-node visibility are preserved.

The same materialized-node evidence rule applies: sync MUST NOT propagate absence in a way that removes the only surviving `add` or `edit` for a materialized node unless equivalent evidence is reappended first.

### Unified physical merge algorithm

The rules above (divergent indices, present-versus-absent, remote suffix) are all special cases of one unified algorithm. This section defines that algorithm explicitly, making the model coherent and implementable.

The algorithm computes one canonical target journal state from the two participating replica states. The merge function is deterministic, symmetric, commutative, and idempotent for unchanged inputs.

**Inputs:**

```
localH  = current local last_journal_index at finalization
remoteH = synchronized remote last_journal_index
P       = max(localH, remoteH)
```

**Prefix merge:** For every index `i` from `1` through `P`, derive the target state:

1. **Both replicas have established state at `i`** (i ≤ localH and i ≤ remoteH):

   | local[ i ] | remote[ i ] | target[ i ] |
   |------------|-------------|-------------|
   | entry E    | entry E     | preserve E at i |
   | absent     | absent      | preserve absence at i |
   | entry E    | absent      | absence at i (see below for evidence preservation) |
   | absent     | entry E     | absence at i (see below for evidence preservation) |
   | entry E    | entry F (E ≠ F) | poison: absence at i; queue E and F for fresh reappend |

   If the present entry was removed by absence, queue it for fresh reappend only when required by the evidence-preservation policy (REQ-JS-16h). If two different entries are poisoned, queue both for fresh reappend.

2. **Only local has established state at `i`** (i ≤ localH, i > remoteH):

   Preserve the local state at `i` (entry or absence). Replicate it to the remote.

3. **Only remote has established state at `i`** (i > localH, i ≤ remoteH):

   The position is unestablished locally. Replicate the remote state at `i` (copy a remote entry into local position `i`, or establish local absence at `i` when the remote position is absent).

**Fresh allocation base:**

After the prefix merge, every position `1 .. P` has one canonical target state. The remaining merge frontier `P` is the fresh allocation base:

```
P = max(
    revalidated local last_journal_index,
    fixed remote last_journal_index
)
```

If both replicas are mutable during the same session, use the maximum revalidated watermark across all participating replicas.

Fresh events receive indices `P + 1 .. P + n`. The final watermark is `P + n`.

**A synchronization convergence point** is reached only when every participating replica has applied the same canonical target state. An implementation may physically apply the plan to replicas sequentially, but the logical target must already be fixed. A partially applied plan is an incomplete synchronization, not a successful convergence point. Retrying must apply or recompute the canonical target rather than inventing a different host-relative layout.

---

### Remote suffix reconciliation

When the remote host has journal entries at indices beyond the local watermark (`remoteH > localH`), those entries belong to the **remote suffix** — positions that do not yet exist in the local journal namespace.

A remote journal position may be copied into the same numeric local position while that local position is still unestablished. A local position `i` is unestablished exactly when:

```
i > current local last_journal_index
```

An unestablished position is not an established absence. Installing remote state into an unestablished position therefore does not violate the prohibition against filling established gaps.

If the position became established locally before sync finalization (a concurrent append claimed it), sync MUST reconcile the local and remote states at `i` using the normal same-index convergence rules.

REQ-JS-16a: A remote suffix position `i` MAY be replicated at local position `i` when `i` is greater than the current committed local `last_journal_index` at darkroom finalization. Replication into an unestablished position is preservation of an existing replicated physical position, not creation of a new journal event.

REQ-JS-16b: A remote suffix position MUST NOT overwrite, fill, replace, or rewrite a position that is already established locally. If position `i` became established locally before sync finalization, sync MUST reconcile the local and remote states at `i` using the same-index convergence rules (poisoning and fresh reappend, per REQ-JS-13 and REQ-JS-14).

REQ-JS-16c: The local `last_journal_index` MUST advance to cover the maximum of the remote watermark and any freshly allocated local indices. After sync completes, the local host's watermark is at least as large as the remote watermark.

REQ-JS-16d: The no-race remote-suffix case (no concurrent ordinary appends) is a testable scenario of the unified algorithm, not a separate normative algorithm. See test scenario T1 (line 441) for an example. The unified algorithm already handles this case: when `closeGarden` is acquired and the remote suffix is analyzed, darkroom finalization rereads `H` and replicates unestablished remote positions according to the prefix merge rules. If a concurrent append has claimed a suffix position, the unified poisoning rules apply.

REQ-JS-16e: The concurrent-append case is an example of revalidation changing `localH` during finalization, not a second algorithm. See test scenario T2 (line 484) for an example. The concurrent finalization protocol is:

1. Acquire `closeGarden` before selecting the active replica or examining established journal structure.
2. Perform reconciliation analysis while holding `closeGarden` — read remote journal entries, identify conflict positions, determine reconciliation needs.
3. Prepare logical journal effects without assigning fresh local indices.
4. Acquire darkroom.
5. **Revalidate all semantic evidence** used by the prepared reconciliation plan for every affected node key:

   - current materialization and graph state (whether the node is materialized, its identifier, its value);
   - latest surviving local `add` or `edit` journal entry (to confirm the intended conflict-winner timestamp is still valid);
   - any appended entries since the initially captured watermark that concern affected keys.

   If any semantic evidence changed in a way that would alter a conflict-resolution decision, sync MUST follow this retry policy:

   **First stale validation:**
   1. Release darkroom.
   2. Retain `closeGarden`.
   3. Rebuild the canonical plan from the fixed remote revision and current local state.
   4. Reacquire darkroom.
   5. Revalidate.

   **Second stale validation (fallback for progress):**
   If the second attempt is also stale:
   1. Continue holding `closeGarden`.
   2. Acquire darkroom.
   3. Recompute the complete affected local reconciliation while holding darkroom.
   4. Commit before releasing darkroom.

   This fallback exists solely to guarantee progress against a continuous stream of local appenders. It sacrifices short darkroom duration only when necessary. Sync NEVER releases `closeGarden` during a retry — new readers must not enter while structural sync is pending.

   Revalidating only physical journal positions is insufficient. Journal positions alone do not capture late-arriving materialization facts: a node that was absent during analysis may have been materialized by a concurrent append, or a node whose latest `add`/`edit` entry sync intended to use as conflict evidence may have been superseded by a newer entry committed during analysis. These semantic facts can change the outcome of per-node conflict resolution and MUST be rechecked.

6. Re-read the current committed local `last_journal_index = H`.
7. Re-read every local journal position that the prepared reconciliation intended to delete, poison, or otherwise reason about.
8. **Compute the unified merge frontier `P`**:

   ```
   P = max(
       H,
       remote.last_journal_index
   )
   ```

   Every numeric position through `P` is resolved by the prefix merge. All newly generated and reappended entries receive indices strictly greater than `P`.

9. **Establish all absences and poisoning through `P`.** Any positions that the reconciliation intends to delete or poison at or below `P` are written as structural deletions. No entry occupies or claims a position at or below `P` that is not already part of the finalized established state.
10. **Canonically order** the queued fresh evidence (remote entries that could not retain their numeric positions because a concurrent append claimed them, reappended conflict-losing evidence) according to the canonical ordering policy (REQ-JS-16i).
11. **Allocate** the fresh evidence at positions `P + 1` through `P + n` where `n` is the number of entries in the ordered list.
12. Install structural deletions/poisoning, fresh appended entries, replicated remote suffix entries (at positions that remained unestablished), graph reconciliation state, and the final watermark in one atomic durable batch.
13. Release darkroom.
14. Release `closeGarden` (reopen the garden).

Under this protocol, all journal-index allocation and established-position mutation happen under darkroom, serialized with ordinary durable commits. The darkroom is held only for finalization, not for the earlier analysis phase (steps 2-3). The protocol revalidates both semantic and physical evidence during finalization, preventing stale conflict-resolution decisions from being applied after concurrent appends have changed the relevant state.

### Evidence collection and deduplication

Before canonical ordering, synchronization MUST build one explicit collection of fresh events, based on the canonical graph and journal target. Use event identity (`JournalEventId`), not payload equality, for deduplication.

REQ-JS-16f: The queued collection consists of:

1. Every distinct event displaced by an entry-versus-entry poisoned position.
2. Every event displaced by entry-versus-absence reconciliation that must survive under the evidence-preservation policy (REQ-JS-16h).
3. Every newly generated journal event required to expose graph-state changes produced by this synchronization.
4. Any other event that the canonical target requires but that cannot remain at its original position.

REQ-JS-16g: After collecting, normalize the collection:

1. Gather every target position (both retained established positions and newly queued entries) containing each `eventId`.
2. Verify all occurrences have the same immutable payload per REQ-JT-24. If not, this is an integrity violation.
3. If an event occurs at exactly one position, preserve it.
4. If it occurs at multiple positions, retain the occurrence with the greatest `JournalIndex`. Change every lower duplicate occurrence to established absence.
5. Remove any event whose `eventId` is already present in a surviving retained target position after the greatest-position resolution.
6. Deduplicate queued copies by `eventId` — the same logical event must not appear more than once in the fresh collection.
7. Preserve multiplicity between different `eventId` values, even when the entries are otherwise byte-for-byte identical. Structural payload equality MUST NOT collapse distinct events with different `eventId` values.
8. Apply the sync-induced-removal evidence policy (REQ-JS-16h — "still relevant" rules).
9. Canonically order the remaining events.
10. Allocate them at `P + 1 ... P + n`.

### Canonical ordering for reappended evidence

When synchronization produces multiple entries queued for fresh reappend (divergent entries, present-versus-absence-shifted entries, remote suffix entries that a concurrent append displaced), those entries MUST be assigned to fresh positions `B+1 .. B+n` in a canonical total order. The canonical order ensures that two hosts synchronizing the same set of remote evidence independently arrive at the same physical placement, preventing further same-index conflicts.

REQ-JS-16i: The canonical ordering for reappended journal evidence is defined as:

1. **By `time` ascending** — entries with an earlier recorded timestamp are placed first.
2. **By node key** (lexicographic `NodeKeyString` order) — entries with the same timestamp are ordered by their node key.
3. **By `creator` hostname** — entries with the same timestamp and node key are ordered by their `Hostname` value.
4. **By `action`** — entries with identical timestamp, node key, and creator are ordered as: `add` < `edit` < `delete` < `invalidate`.
5. **By `NodeIdentifier`** — entries that are still identical after all prior criteria are ordered by their `NodeIdentifier` value.
6. **By `eventId.creator`** ascending — entries identical by all prior criteria are ordered by their event creator.
7. **By `eventId.originIndex`** ascending — entries with the same event creator are ordered by their origin index.

Because `eventId` is globally unique, this is a true total order. All prior keys (time, node key, hostname, action, identifier) are deterministic across synchronized hosts. The `eventId` fields are immutable and survive copy and reappend. Two hosts synchronizing the same set of reappended evidence therefore arrive at the exact same physical placement.

### Still-relevant evidence for sync-induced removal

When a journal entry is removed from an established position by sync (by poisoning or absence propagation), some entries may need to survive through fresh reappend while others are genuinely obsolete. This section applies only to sync-induced removal. Compaction follows its own retention rules (see `incremental-graph-journal-compaction.md`) and never reappends removed entries.

All relevance decisions are based on the canonical graph and journal target, not on whichever host is currently called local.

REQ-JS-16h: The following kinds of evidence are "still relevant" and MUST be reappended when removed from an established position by sync:

- An `add` or `edit` entry that is the only surviving value evidence for a node that is materialized in the canonical graph target (mandatory under REQ-JC-07).
- A `delete` entry that carries the most recent timestamp for a node key that is deleted in the canonical graph target (needed for sync conflict convergence).
- An `invalidate` entry that is the only surviving journal record of a freshness downgrade for a node that is materialized in the canonical graph target and whose latest retained `add`/`edit` evidence does not subsume the invalidation.

The following kinds of evidence are NOT "still relevant" and MAY be dropped:

- Redundant `edit` entries for a node key that has a later surviving `edit` or `delete` entry.
- `invalidate` entries for a node that has a later surviving `add`, `edit`, or `delete` entry that supersedes the invalidation.
- Journal entries for a node key that has been deleted on all synchronized hosts and whose deletion has been acknowledged by all hosts.
- Any entry older than a retained entry for the same node key that carries equivalent or stronger evidence.

"Still relevant" is evaluated per removed entry at the time of removal. If the entry being removed is not the only surviving source of its kind of evidence for its node key, it may be dropped without reappend.

### Garden concurrency for structural sync

Sync MUST NOT fill, replace, or rewrite entries at established journal positions (at or below the committed watermark). After publication, an established position may remain unchanged or become absent, but it must never change from absent to present and must never change from one entry value to another. This guarantees that a cursor that has already scanned past position `i` cannot later discover a new entry behind it.

REQ-JS-17: Sync operations that make structural changes to established journal positions MUST call `closeGarden`. Structural changes are limited to:

- poisoning an existing index (making it absent);
- deleting either conflicting entry at an existing index;
- applying a remote compaction set locally;
- performing any other established-position deletion or poisoning.

Structural sync MUST NOT fill a previously absent established index, replace an established entry, or rewrite an entry's content. All new journal evidence MUST be appended at fresh indices strictly greater than the current committed watermark.

The structural sync phase MUST hold `closeGarden` through its analysis and atomic durable mutation, following the normative finalization protocol in REQ-JS-16e. The durable batch uses darkroom inside the garden closure.

REQ-JS-18: A purely append-only sync action that writes only fresh local indices MAY proceed without garden access. Fresh reappended entries MUST be allocated from the then-current watermark under the normal durable commit serialization. Do not assume that a previously captured position remains available while ordinary appenders continue; the allocation base `P = max(localH, remoteH)` is determined during darkroom finalization.

### Sync order

REQ-JS-19: Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. `JournalIndex` order is not a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule (REQ-JS-13).

### Remote compaction

REQ-JS-20: During sync, a host MAY transmit the set of `JournalIndex` values it has compacted away. The receiving host MAY then compact the corresponding entries from its own journal storage, provided doing so satisfies the compaction rules in `incremental-graph-journal-compaction.md`.

---

## Eventual consistency

REQ-JS-21: After all hosts have completed synchronization and no further graph mutations occur, the following must hold:

1. **Graph state converges**: For every node key, all hosts agree on the node's value (or absence).
2. **Physical journal converges**: Per REQ-JS-12 and the unified merge algorithm, all hosts agree on each index's state (same entry or absent). Any pre-existing compaction absence propagates to all hosts during convergence via the unified rule (absence wins at any established index). After convergence, no disagreement about individual journal positions remains.
3. **Journal queries are consistent with physical convergence**: After convergence, hosts that compact the same set of indices return the same set of possible changes. Hosts that independently compact different subsets after convergence may return different subsets, but no host returns a `PossibleNodeChange` at a given index that contradicts the converged journal entry for that index.

A pairwise journal reconciliation computes one canonical target journal state from the two participating replica states. The merge function is deterministic, symmetric, commutative, and idempotent for unchanged inputs. A synchronization convergence point is reached only when every participating replica has applied the same canonical target state. An implementation may physically apply the plan to replicas sequentially, but the logical target must already be fixed; the session is not converged until all participants expose that target.

---

## Host identity and journal consumers

REQ-JS-22: Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Interaction with compaction

Sync operates on the journal storage that exists at sync time. Compaction may have removed entries before sync.

REQ-JS-23: Sync uses only surviving journal entries for conflict comparison. Absent journal entries are treated as "no journal evidence" — sync MUST NOT fall back to the `timestamps` sublevel as a replacement for missing journal entries. If no journal entry exists for a node key, sync uses its remaining available evidence (e.g., the fact of materialization and the node's identifier allocation) for conflict-resolution decisions according to the rules in this document.

REQ-JS-24: Compaction MUST NOT remove the only surviving `add` or `edit` entry for a materialized node (see REQ-JC-07). This ensures sync always has at least one journal-backed timestamp per materialized node for conflict comparison. If compaction adheres to this rule, the "no journal evidence" case in REQ-JS-21 can only occur for nodes that were deleted or dematerialized on all synchronized hosts before compaction.

---

## Testable scenarios

### T1 — Sync remote suffix preserved at same index (no race)

```
local H = 5
remote H = 6, remote[6] = E

sync enters darkroom
sync reads H = 5 (no concurrent append has committed)
index 6 is unestablished locally (6 > 5)
sync replicates E at local index 6
sync commits H = 6
```

The remote entry is preserved at its original numeric position because it was unestablished locally.

### T1a — Same event through two paths (deduplication)

```
Host A:
  index 1 = absent
  index 2 = event E with eventId X

Host B:
  index 1 = event E with eventId X
```

Reconciliation:
- absence wins at index 1 (event E is queued for possible reappend);
- index 2 preserves event E on A;
- the displaced copy of E (from index 1) is deduplicated by eventId X against the surviving copy at index 2;
- final journal contains exactly one surviving copy of event E.

### T1b — Identical payload, distinct event IDs

```
E1: action="edit", key="a", time=100, eventId={ creator: A, originIndex: 5 }
E2: action="edit", key="a", time=100, eventId={ creator: A, originIndex: 10 }
```

Reconciliation MUST preserve E1 and E2 as two distinct events. Structural payload equality must not collapse them despite identical action, key, time, and creator.

### T2 — Sync remote suffix races with ordinary append

```
local H = 5
remote H = 6, remote[6] = E

sync closes the garden and analyzes

ordinary append commits F at local index 6, H becomes 6

sync enters darkroom, re-reads H = 6
sync detects that index 6 is now established locally with F
sync treats index 6 as a same-index conflict (F vs E)
sync establishes absence at 6 (poisoning F from index 6)
sync computes P = max(6, 6) = 6
sync reappends F at index 7 and E at index 8
sync commits H = 8
```

The final result must:
- not overwrite index 6 (F is removed, not replaced);
- preserve both relevant local and remote evidence (F and E both reappended at fresh indices);
- allocate all reappended evidence from the then-current allocation base.

### T3 — Present-versus-absent propagation

```
Host A: index 5 = E (established entry)
Host B: index 5 = absent (compacted/deleted)

Sync converges:
  index 5 becomes absent on A (absence wins)
  E is reappended at index 6 on A (if E is still relevant evidence)
  H advances to 6 on A
```

Absence propagates to all hosts. Relevant evidence is reappended freshly before or atomically with deletion. After convergence, every host agrees on each established position.

### T4 — Sparse remote suffix preserves remote physical positions

```
Local:
  H = 5

Remote:
  H = 100
  indices 6 .. 99 are absent
  index 100 = E
```

After reconciliation, before fresh displaced or generated events:

```
Local and remote canonical prefix:
  indices 6 .. 99 = established absence
  index 100 = E
  H = 100
```

The event remains at replicated physical position 100. It must not be moved to index 6. Any fresh sync-generated events are allocated above 100.

### T5 — Concurrent append claims a remote suffix position

```
local H = 5
remote[6] = E, remoteH = 6

before sync finalization:
  ordinary local append commits F at index 6
  localH becomes 6

at finalization:
  local[6] = F, remote[6] = E
  entries differ → target[6] = absent
  both F and E queued for fresh placement
  P = max(6, 6) = 6
  canonically ordered F and E at indices 7 and 8
  H = 8
```

The original established position becomes absent, and the displaced events survive at fresh positions. The remote suffix entry at 6 was not unconditionally reallocated — it retained its numeric position until a concurrent append made that position established locally.

### T6 — Duplicate event at several retained positions

```
index 3 = event X (eventId = { creator: A, originIndex: 3 })
index 8 = event X (eventId = { creator: A, originIndex: 3 })
```

Expected canonical result after reconciliation:

```
index 3 = absent
index 8 = event X
```

The greatest position survives. The lower duplicate at index 3 becomes established absence. No fresh copy of X is queued because a later surviving copy already exists at index 8.

### T7 — Caller-direction symmetry

```
canonicalMerge(A, B) = canonicalMerge(B, A)
```

Run the same fixed inputs as both `canonicalMerge(A, B)` and `canonicalMerge(B, A)`. The complete canonical target (graph target, journal prefix, fresh event list, final watermark) MUST be byte-for-byte identical regardless of which replica is designated as "first" argument.

### T8 — Repeated merge idempotence

```
canonicalMerge(T, T) = T
```

Merging an already converged target `T` with itself creates:
- no new sync event;
- no new journal index;
- no watermark change.

The result is identical to the input target `T`.
