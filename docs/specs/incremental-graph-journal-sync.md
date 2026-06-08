# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how the journal participates in synchronization between hosts. Synchronization must reconcile graph state and journal state together so that graph-state reconciliation is visible through later journal queries.

---

## Core principles

1. **Graph and journal are reconciled together.** Sync does not treat graph state and journal state as independent concerns. A reconciliation that changes graph state must also make those changes visible through the journal.

2. **Timestamp-based conflict resolution.** For concurrent edits to the same semantic node key, the recorded entry with the later `time` field wins. If `time` produces a tie, the node with the lexicographically greater `JournalEntry.id` (`NodeIdentifier` converted to string) wins. Since `time` comes from host wall clocks, this is a last-writer-wins-by-recorded-wall-clock policy with deterministic tie-breakers.

3. **Wall-clock-based resolution.** A particular host's wall clock may be incorrect, but this is the best available signal for conflict ordering — the system trusts hosts and does not rely on external time authorities. The timestamp field is the entry's recorded local time, used as-is for conflict comparison.

---

## Conflict resolution

### Per-node-key resolution

When synchronizing two hosts, for each node key that appears in both hosts' graph state (potentially under different `NodeIdentifier` values in each host's allocation namespace):

REQ-JS-01: The host whose journal entry has the later `JournalEntry.time` wins the conflict. The winning host's value is retained; the losing host's identifier and associated records are removed or replaced.

REQ-JS-02: If both hosts have the same `time` for the conflicting node, tie-breaking is decided via lexicographic comparison of `JournalEntry.id` (`NodeIdentifier` converted to string).

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

REQ-JS-09: If the remote host has deleted a node that the local host has materialized:

- If the remote deletion timestamp is later than the local node's last-change timestamp, the deletion wins. The local node is removed, and a `delete` journal entry is emitted.
- If the local node's last-change timestamp is later, the local node is preserved. No `delete` is emitted locally; the remote host will handle its side on its next sync.

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

REQ-JS-14: Gaps produced by poisoned indices follow REQ-JC-04 (sparse storage is tolerated).

### Sync order

REQ-JS-15: Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. `JournalIndex` order is not a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule (REQ-JS-13).

### Remote compaction

REQ-JS-16: During sync, a host MAY transmit the set of `JournalIndex` values it has compacted away. The receiving host MAY then compact the corresponding entries from its own journal storage, provided doing so satisfies the compaction rules in `incremental-graph-journal-compaction.md`.

---

## Eventual consistency

REQ-JS-17: After all hosts have completed synchronization and no further graph mutations occur, the following must hold:

1. **Graph state converges**: For every node key, all hosts agree on the node's value (or absence).
2. **Physical journal converges**: Per REQ-JS-12, all hosts agree on each index's state.
3. **Journal-observable behavior converges**: Any host calling `graph.possibleMaybeChanges` after convergence sees the same set of possible changes.

---

## Host identity and journal consumers

REQ-JS-18: Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Interaction with compaction

Sync operates on the journal storage that exists at sync time. Compaction may have removed entries before sync. This is safe because:

1. Compaction removes only entries that are no longer needed for correctness (see `incremental-graph-journal-compaction.md`).
2. Conflict resolution uses timestamps from surviving journal entries or from node metadata (the `timestamps` sublevel records creation and modification times per node identifier).
3. If a node's journal entry has been compacted away, the node's modification timestamp from the `timestamps` sublevel is used as the authoritative comparison value.

REQ-JS-19: During conflict resolution, if a node's journal entry no longer exists, sync MUST use the node's modification timestamp from the `timestamps` sublevel. If neither exists (should not happen for a materialized node with identifier-lookup integrity), sync MUST treat the node's timestamp as `0` (earliest possible) for conflict comparison purposes.
