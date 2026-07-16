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

### Implementation of resolution

REQ-JS-03: When a node key conflict is resolved against the local host (the local host loses):

- The local `NodeIdentifier` and all associated graph-state records (value, freshness, inputs, revdeps, counters, timestamps) are removed.
- A `delete` journal entry is emitted for the local node key, with `time` set to the current sync time and `creator` set to the local host.
- The remote host's `NodeIdentifier` and value replace the local records.

REQ-JS-04: When a node key conflict is resolved in favor of the local host (the local host wins):

- The local state is preserved unchanged.
- No `delete` entry is emitted for the remote node key on the local host.
- The remote host will resolve the conflict in the same way when it syncs, producing a `delete` on its side.

REQ-JS-05: The resolution algorithm MUST be deterministic and commutative: two hosts applying the same set of changes in any order must arrive at the same final state. The timestamp-then-identifier tie-breaking rules satisfy this.

---

## Journal entries produced by sync

REQ-JS-06: If synchronization changes graph state, sync MUST make that change visible through the journal. Specifically:

- If a remote node value is adopted (because the remote timestamp wins), an `edit` journal entry is appended for the node key.
- If a remote node is newly materialized locally (first time seen), an `add` journal entry is appended.
- If a local node is removed because the remote host deleted it and the remote deletion timestamp wins, a `delete` journal entry is appended.

REQ-JS-07: Sync MUST NOT omit a journal entry that would be necessary for later `graph.possibleMaybeChanges` queries to observe a material graph change.

---

## Delete entries from conflict resolution

### Conflicting identifier allocation

REQ-JS-08: When two hosts independently allocate `NodeIdentifier` values for the same node key (i.e., both hosts pulled the same previously-unmaterialized node before syncing), one identifier must lose. The losing identifier produces a `delete` journal entry:

- The entry's `action` is `"delete"`.
- The entry's key is the semantic node key (same for both identifiers).
- The entry's `time` is set to the sync resolution time.
- The entry's `creator` is set to the local host.

The winning identifier's value produces an `edit` entry per REQ-JS-06.

### Remote deletion

REQ-JS-09: If the remote host has a surviving `delete` journal entry for a node key that the local host has materialized:

- Compare the remote `delete` entry's `time` against the local node's latest surviving `add` or `edit` journal entry time.
- If the remote `delete` time is later, the deletion wins. The local node is removed, and a `delete` journal entry is emitted.
- If the local node's latest `add` or `edit` entry time is later, the local node is preserved. No `delete` is emitted locally; the remote host handles its side on its next sync.

---

## Journal storage during sync

REQ-JS-10: New journal entries appended during sync (conflict-resolution notifications) MUST receive fresh `JournalIndex` values. These are allocated from the local watermark and appended at the current head of the journal.

REQ-JS-11: After sync, the local `last_journal_index` MUST be advanced to cover the maximum of the pre-sync local value, the pre-sync remote value, and any freshly allocated indices. This ensures the watermark reflects all indices present on any synchronized host.

---

## Physical journal convergence

Synchronization must bring journal storage into physical agreement.

REQ-JS-12: After synchronization completes, for every `JournalIndex` `i`, all synchronized hosts MUST agree that `rendered/r/journal/i` is either:

- the **same** `JournalEntry` value (byte-for-byte identical), or
- **absent** (compacted or deleted on that host).

What is NOT allowed is host A having one `JournalEntry` at index `i` while host B has a different `JournalEntry` at the same index `i`.

### Resolving divergent indices

REQ-JS-13: If synchronization discovers that two hosts have different `JournalEntry` values at the same `JournalIndex` `i`, that index is poisoned. Both conflicting entries MUST be deleted from index `i`. Any still-relevant changes described by the conflicting entries MUST be appended at fresh `JournalIndex` values determined by the allocation base `B`:

```
B = max(
    current local last_journal_index,
    remote last_journal_index,
    greatest fixed position retained by the reconciliation
)
```

All newly generated and reappended entries MUST receive indices strictly greater than `B`. This ensures that reappended entries do not collide with the remote suffix or with any position that the reconciliation intends to preserve.

If both conflicting entries describe changes to the same node key, the re-appended entries are distinct `PossibleNodeChange` values for that key at different journal indices. This is a direct consequence of the poisoning rule: each conflicting entry that carried a still-relevant change produces its own re-appended entry.

This rule avoids the risk that choosing one authoritative entry to remain at the poisoned index would make a caller using a previous `since` value skip a change it has not observed.

### Present-versus-absent conflict

REQ-JS-14: If one synchronized host has an established journal entry at index `i` and another host has an established absence at the same index `i`, absence wins at index `i`. The present entry MUST be removed from index `i` on every host that has it. Absence at an established index may be caused by compaction, poisoning, propagated remote compaction, or any other structural deletion.

If the removed entry still carries relevant journal evidence (i.e., it is the only surviving `add` or `edit` for a materialized node key), that evidence MUST be reappended at a fresh local index before or atomically with removing the established entry. This ensures that compaction evidence rules (REQ-JC-07) and materialized-node visibility are preserved.

The same materialized-node evidence rule applies: sync MUST NOT propagate absence in a way that removes the only surviving `add` or `edit` for a materialized node unless equivalent evidence is reappended first.

### Remote suffix reconciliation

When the remote host has journal entries at indices beyond the local watermark (`remoteH > localH`), those entries belong to the **remote suffix** — positions that do not yet exist in the local journal namespace.

A remote journal position may be copied into the same numeric local position while that local position is still unestablished. A local position `i` is unestablished exactly when:

```
i > current local last_journal_index
```

An unestablished position is not an established absence. Installing remote state into an unestablished position therefore does not violate the prohibition against filling established gaps.

If the position became established locally before sync finalization (a concurrent append claimed it), sync MUST reconcile the local and remote states at `i` using the normal same-index convergence rules.

REQ-JS-14a: A remote suffix position `i` MAY be replicated at local position `i` when `i` is greater than the current committed local `last_journal_index` at darkroom finalization. Replication into an unestablished position is preservation of an existing replicated physical position, not creation of a new journal event.

REQ-JS-14b: A remote suffix position MUST NOT overwrite, fill, replace, or rewrite a position that is already established locally. If position `i` became established locally before sync finalization, sync MUST reconcile the local and remote states at `i` using the same-index convergence rules (poisoning and fresh reappend, per REQ-JS-13 and REQ-JS-14).

REQ-JS-14c: The local `last_journal_index` MUST advance to cover the maximum of the remote watermark and any freshly allocated local indices. After sync completes, the local host's watermark is at least as large as the remote watermark.

REQ-JS-14d: In the basic remote-suffix case (no concurrent ordinary appends and no pre-existing local state at the relevant indices), the procedure is:

1. Acquire `closeGarden` before examining established journal structure.
2. Perform reconciliation analysis while holding `closeGarden` — read remote journal entries, determine reconciliation needs, and prepare logical journal effects without assigning final local indices.
3. Acquire darkroom.
4. Read `last_journal_index = H`.
5. **Determine the allocation base `B`**:

   ```
   B = max(
       H,
       remote.last_journal_index,
       greatest fixed position retained by the reconciliation
   )
   ```

6. For each remote suffix position `i` such that `H < i ≤ remoteH`:

   If `i ≤ B` and position `i` is still unestablished locally (i.e., no concurrent append committed at `i` before darkroom):
   - Replicate the remote entry at local position `i`.

   If `i > B` or if position `i` became established locally (a concurrent append committed there):
   - Treat as fresh evidence. Queue the remote entry for allocation above `B`.

7. **Establish all absences and poisoning through `max(H, localH)`.** Known-absent remote suffix positions (indices where the remote host has no entry) establish local absence at those positions, advancing the watermark to cover them.
8. **Canonically order** the queued fresh evidence (remote entries that could not retain their positions, reappended conflict-losing entries) according to the canonical ordering policy (see "Canonical ordering for reappended evidence").
9. **Allocate** the fresh evidence at positions `B + 1` through `B + n` where `n` is the number of entries in the ordered list.
10. Install replicated entries, established absences, fresh entries, and the final watermark (now at least `max(B + n, remoteH)`) in one atomic durable batch.
11. Release darkroom.
12. Release `closeGarden`.

REQ-JS-14e: In the concurrent case, because `closeGarden` does not exclude ordinary append-only journal growth (see the compatibility table in `docs/specs/incremental-graph-locking-design.md`), ordinary appends may commit while structural sync is analyzing. The following normative finalization protocol prevents races. Hold darkroom only during finalization, not during analysis:

1. Acquire `closeGarden` before selecting the active replica or examining established journal structure.
2. Perform reconciliation analysis while holding `closeGarden` — read remote journal entries, identify conflict positions, determine reconciliation needs.
3. Prepare logical journal effects without assigning fresh local indices.
4. Acquire darkroom.
5. **Revalidate all semantic evidence** used by the prepared reconciliation plan for every affected node key:

   - current materialization and graph state (whether the node is materialized, its identifier, its value);
   - latest surviving local `add` or `edit` journal entry (to confirm the intended conflict-winner timestamp is still valid);
   - any appended entries since the initially captured watermark that concern affected keys.

   If any semantic evidence changed in a way that would alter a conflict-resolution decision, sync MUST either recompute the affected resolution under darkroom or discard the entire stale plan and retry. Revalidating only physical journal positions is insufficient.

   Journal positions alone do not capture late-arriving materialization facts: a node that was absent during analysis may have been materialized by a concurrent append, or a node whose latest `add`/`edit` entry sync intended to use as conflict evidence may have been superseded by a newer entry committed during analysis. These semantic facts can change the outcome of per-node conflict resolution and MUST be rechecked.

6. Re-read the current committed local `last_journal_index = H`.
7. Re-read every local journal position that the prepared reconciliation intended to delete, poison, or otherwise reason about.
8. **Determine the allocation base `B`**:

   ```
   B = max(
       H,
       remote.last_journal_index,
       greatest fixed position retained by the reconciliation
   )
   ```

   The "greatest fixed position retained by the reconciliation" is the highest established position at or below `max(H, remote.last_journal_index)` that the reconciliation will preserve unchanged at its numeric index. All newly generated and reappended entries MUST receive indices strictly greater than `B`.

9. **Establish all absences and poisoning through `B`.** Any positions that the reconciliation intends to delete or poison at or below `B` are written as structural deletions. No entry occupies or claims a position at or below `B` that is not already part of the finalized established state.
10. **Canonically order** the queued fresh evidence (remote entries that could not retain their numeric positions because a concurrent append claimed them, reappended conflict-losing evidence) according to the canonical ordering policy (see "Canonical ordering for reappended evidence").
11. **Allocate** the fresh evidence at positions `B + 1` through `B + n` where `n` is the number of entries in the ordered list.
12. Install structural deletions/poisoning, fresh appended entries, replicated remote suffix entries (at positions that remained unestablished), graph reconciliation state, and the final watermark in one atomic durable batch.
13. Release darkroom.
14. Release `closeGarden` (reopen the garden).

Under this protocol, all journal-index allocation and established-position mutation happen under darkroom, serialized with ordinary durable commits. The darkroom is held only for finalization, not for the earlier analysis phase (steps 2-3). The protocol revalidates both semantic and physical evidence during finalization, preventing stale conflict-resolution decisions from being applied after concurrent appends have changed the relevant state.

### Canonical ordering for reappended evidence

When synchronization produces multiple entries queued for fresh reappend (divergent entries, present-versus-absence-shifted entries, remote suffix entries that a concurrent append displaced), those entries MUST be assigned to fresh positions `B+1 .. B+n` in a canonical total order. The canonical order ensures that two hosts synchronizing the same set of remote evidence independently arrive at the same physical placement, preventing further same-index conflicts.

REQ-JS-14f: The canonical ordering for reappended journal evidence is defined as:

1. **By `time` ascending** — entries with an earlier recorded timestamp are placed first.
2. **By node key** (lexicographic `NodeKeyString` order) — entries with the same timestamp are ordered by their node key.
3. **By `creator` hostname** — entries with the same timestamp and node key are ordered by their `Hostname` value.
4. **By `action`** — entries with identical timestamp, node key, and creator are ordered as: `add` < `edit` < `delete` < `invalidate`.
5. **By `NodeIdentifier`** — entries that are still identical after all prior criteria are ordered by their `NodeIdentifier` value.

This total order is deterministic across all synchronized hosts because the comparison keys (timestamp, node key string, hostname, action, identifier) are all well-defined, comparable values that are invariant across synchronized hosts.

### Still-relevant evidence for sync-induced removal

When a journal entry is removed from an established position by sync (by poisoning or absence propagation), some entries may need to survive through fresh reappend while others are genuinely obsolete. This section applies only to sync-induced removal. Compaction follows its own retention rules (see `incremental-graph-journal-compaction.md`) and never reappends removed entries.

REQ-JS-14g: The following kinds of evidence are "still relevant" and MUST be reappended when removed from an established position by sync:

- The only surviving `add` or `edit` entry for a currently materialized node key (mandatory under REQ-JC-07).
- A `delete` entry that carries the most recent timestamp for a node key that was present on another host (needed for sync conflict convergence).
- An `invalidate` entry that is the only surviving journal record of a freshness downgrade for a materialized node whose `add`/`edit` evidence is still needed but whose value might have changed.

The following kinds of evidence are NOT "still relevant" and MAY be dropped:

- Redundant `edit` entries for a node key that has a later surviving `edit` or `delete` entry.
- `invalidate` entries for a node that has a later surviving `add`, `edit`, or `delete` entry that supersedes the invalidation.
- Journal entries for a node key that has been deleted on all synchronized hosts and whose deletion has been acknowledged by all hosts.
- Any entry older than a retained entry for the same node key that carries equivalent or stronger evidence.

"Still relevant" is evaluated per removed entry at the time of removal. If the entry being removed is not the only surviving source of its kind of evidence for its node key, it may be dropped without reappend.

### Garden concurrency for structural sync

Sync MUST NOT fill, replace, or rewrite entries at established journal positions (at or below the committed watermark). After publication, an established position may remain unchanged or become absent, but it must never change from absent to present and must never change from one entry value to another. This guarantees that a cursor that has already scanned past position `i` cannot later discover a new entry behind it.

REQ-JS-15: Sync operations that make structural changes to established journal positions MUST call `closeGarden`. Structural changes are limited to:

- poisoning an existing index (making it absent);
- deleting either conflicting entry at an existing index;
- applying a remote compaction set locally;
- performing any other established-position deletion or poisoning.

Structural sync MUST NOT fill a previously absent established index, replace an established entry, or rewrite an entry's content. All new journal evidence MUST be appended at fresh indices strictly greater than the current committed watermark.

The structural sync phase MUST hold `closeGarden` through its analysis and atomic durable mutation, following the normative finalization protocol in REQ-JS-14e. The durable batch uses darkroom inside the garden closure.

REQ-JS-16: A purely append-only sync action that writes only fresh local indices MAY proceed without garden access. Fresh reappended entries MUST be allocated from the then-current watermark under the normal durable commit serialization. Do not assume that a previously captured position remains available while ordinary appenders continue; the allocation base `B = max(local H, remote H, greatest fixed position retained)` is determined during darkroom finalization.

### Sync order

REQ-JS-17: Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. `JournalIndex` order is not a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule (REQ-JS-13).

### Remote compaction

REQ-JS-18: During sync, a host MAY transmit the set of `JournalIndex` values it has compacted away. The receiving host MAY then compact the corresponding entries from its own journal storage, provided doing so satisfies the compaction rules in `incremental-graph-journal-compaction.md`.

---

## Eventual consistency

REQ-JS-19: After all hosts have completed synchronization and no further graph mutations occur, the following must hold:

1. **Graph state converges**: For every node key, all hosts agree on the node's value (or absence).
2. **Physical journal converges**: Per REQ-JS-12, all hosts agree on each index's state (same entry or absent). Any pre-existing compaction absence propagates to all hosts during convergence via the present-versus-absent rule (REQ-JS-14). After convergence, no disagreement about individual journal positions remains.
3. **Journal queries are consistent with physical convergence**: After convergence, hosts that compact the same set of indices return the same set of possible changes. Hosts that independently compact different subsets after convergence may return different subsets, but no host returns a `PossibleNodeChange` at a given index that contradicts the converged journal entry for that index.

---

## Host identity and journal consumers

REQ-JS-20: Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Interaction with compaction

Sync operates on the journal storage that exists at sync time. Compaction may have removed entries before sync.

REQ-JS-21: Sync uses only surviving journal entries for conflict comparison. Absent journal entries are treated as "no journal evidence" — sync MUST NOT fall back to the `timestamps` sublevel as a replacement for missing journal entries. If no journal entry exists for a node key, sync uses its remaining available evidence (e.g., the fact of materialization and the node's identifier allocation) for conflict-resolution decisions according to the rules in this document.

REQ-JS-22: Compaction MUST NOT remove the only surviving `add` or `edit` entry for a materialized node (see REQ-JC-07). This ensures sync always has at least one journal-backed timestamp per materialized node for conflict comparison. If compaction adheres to this rule, the "no journal evidence" case in REQ-JS-21 can only occur for nodes that were deleted or dematerialized on all synchronized hosts before compaction.

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
sync determines allocation base B = max(6, 6, 0) = 6
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
