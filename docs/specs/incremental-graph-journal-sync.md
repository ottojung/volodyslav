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

REQ-JS-13: If synchronization discovers that two hosts have different `JournalEntry` values at the same `JournalIndex` `i`, that index is poisoned. Both conflicting entries MUST be deleted from index `i`. Any still-relevant changes described by the conflicting entries MUST be appended at fresh `JournalIndex` values greater than `max(local.last_journal_index, remote.last_journal_index)` computed before allocating the re-appended entries.

If both conflicting entries describe changes to the same node key, the re-appended entries are distinct `PossibleNodeChange` values for that key at different journal indices. This is a direct consequence of the poisoning rule: each conflicting entry that carried a still-relevant change produces its own re-appended entry.

This rule avoids the risk that choosing one authoritative entry to remain at the poisoned index would make a caller using a previous `since` value skip a change it has not observed.

### Present-versus-absent conflict

REQ-JS-14: If one synchronized host has an established journal entry at index `i` and another host has an established absence at the same index `i`, absence wins at index `i`. The present entry MUST be removed from index `i` on every host that has it. Absence at an established index may be caused by compaction, poisoning, propagated remote compaction, or any other structural deletion.

If the removed entry still carries relevant journal evidence (i.e., it is the only surviving `add` or `edit` for a materialized node key), that evidence MUST be reappended at a fresh local index before or atomically with removing the established entry. This ensures that compaction evidence rules (REQ-JC-07) and materialized-node visibility are preserved.

The same materialized-node evidence rule applies: sync MUST NOT propagate absence in a way that removes the only surviving `add` or `edit` for a materialized node unless equivalent evidence is reappended first.

### Garden concurrency for structural sync

Sync MUST NOT fill, replace, or rewrite entries at established journal positions (at or below the committed watermark). After publication, an established position may remain unchanged or become absent, but it must never change from absent to present and must never change from one entry value to another. This guarantees that a cursor that has already scanned past position `i` cannot later discover a new entry behind it.

REQ-JS-15: Sync operations that make structural changes to established journal positions MUST call `closeGarden`. Structural changes are limited to:

- poisoning an existing index (making it absent);
- deleting either conflicting entry at an existing index;
- applying a remote compaction set locally;
- performing any other established-position deletion or poisoning.

Structural sync MUST NOT fill a previously absent established index, replace an established entry, or rewrite an entry's content. All new journal evidence MUST be appended at fresh indices strictly greater than the current committed watermark.

The structural sync phase MUST hold `closeGarden` through its analysis and atomic durable mutation. The durable batch still uses darkroom inside the garden closure.

REQ-JS-16: A purely append-only sync action that writes only fresh local indices MAY proceed without garden access. Fresh reappended entries MUST be allocated from the then-current watermark under the normal durable commit serialization. Do not assume that a previously captured `H + 1` remains available while ordinary appenders continue.

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
