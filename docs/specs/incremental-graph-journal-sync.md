# IncrementalGraph Journal Synchronization

## Purpose

This document specifies how the journal participates in synchronization between hosts. Synchronization must reconcile graph state and journal state together, so that graph-state reconciliation is visible through later journal queries.

---

## Core principles

1. **Graph and journal are reconciled together.** Sync does not treat graph state and journal state as independent concerns. A reconciliation that changes graph state must also make those changes visible through the journal.

2. **Conservative visibility.** Sync may append journal entries to ensure graph-state reconciliation is visible through later `graph.possibleMaybeChanges` results. When in doubt, add a possible change rather than risk silent staleness.

3. **Timestamp-based conflict resolution (v1/default).** For concurrent edits to the same semantic node key, the recorded entry with the later `time` field wins. Since `time` comes from host wall clocks, this is a last-writer-wins-by-recorded-wall-clock policy with deterministic tie-breakers. It is deliberately lossy: incorrect host clocks or clock skew may cause updates to be silently discarded. This is acceptable for v1.

4. **Host clocks are not trusted.** The system operates correctly under correct clocks; under incorrect clocks, outcomes reflect the incorrect timestamps. Future versions may introduce custom merge logic to refine or replace this rule.

---

## Conflict resolution

### Per-node-key resolution

When synchronizing two hosts, for each node key that appears in both hosts' graph state (potentially under different `NodeIdentifier` values in each host's allocation namespace):

REQ-JS-01: The host whose journal entry has the later `JournalEntry.time` wins the conflict. The winning host's value is retained; the losing host's identifier and associated records are removed or replaced.

REQ-JS-02: If both hosts have the same `time` for the conflicting node, tie-breaking proceeds in this order:

1. Lexicographic comparison of `JournalEntry.creator` (`Hostname` converted to string).
2. Lexicographic comparison of `JournalEntry.id` (`NodeIdentifier` converted to string).

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

REQ-JS-05: The resolution algorithm MUST be deterministic and commutative: two hosts applying the same set of changes in any order must arrive at the same final state. The timestamp-then-creator-then-identifier tie-breaking rules satisfy this.

---

## Conservative journal append

REQ-JS-06: If synchronization changes graph state in a way that could affect later journal queries, sync MUST make that change visible through later `graph.possibleMaybeChanges` results. This is achieved by appending additional journal entries during sync.

Specifically:

- If a remote node value is adopted (because the remote timestamp wins), an `edit` journal entry is appended for the local node key.
- If a remote node is newly materialized locally (first time seen), an `add` journal entry is appended.
- If a local node is removed because the remote host deleted it and the remote deletion timestamp wins, a `delete` journal entry is appended.

REQ-JS-07: Sync MAY append a journal entry even when the graph state is already consistent. For example, if two hosts independently computed the same value for a node (same `time`, same `creator`), sync MAY still append a redundant `edit` entry to ensure later queries re-evaluate the node. This is conservative behavior and is allowed.

REQ-JS-08: Sync MUST NOT omit a journal entry that would be necessary for later `graph.possibleMaybeChanges` queries to observe a material graph change.

---

## Duplicate and redundant entries

REQ-JS-09: Sync MAY create duplicate `PossibleNodeChange` values for the same node key (e.g., one from the original emission and one from the sync reconciliation). Journal consumers must tolerate receiving multiple change notifications for the same node. This is a consequence of the conservative design:

> If sync changes graph state in a way that could affect journal consumers, sync must make that visible through later possible changes.

---

## Delete entries from conflict resolution

### Conflicting identifier allocation

REQ-JS-10: When two hosts independently allocate `NodeIdentifier` values for the same node key (i.e., both hosts pulled the same previously-unmaterialized node before syncing), one identifier must lose. The losing identifier produces a `delete` journal entry:

- The entry's `action` is `"delete"`.
- The entry's key is the semantic node key (same for both identifiers).
- The entry's `time` is set to the sync resolution time.
- The entry's `creator` is set to the local host.

This ensures that journal consumers on the local host see a `delete` for the losing identifier and an `add` or `edit` for the winning identifier's value.

### Remote deletion

REQ-JS-11: If the remote host has deleted a node that the local host has materialized:

- If the remote deletion timestamp is later than the local node's last-change timestamp, the deletion wins. The local node is removed, and a `delete` journal entry is emitted.
- If the local node's last-change timestamp is later, the local node is preserved, and its identifier and value are treated as the winning side. No `delete` is emitted locally; the remote host will handle its side on its next sync.

---

## Journal storage during sync

REQ-JS-12: New journal entries appended during sync (conservative entries, conflict-resolution notifications) MUST receive fresh `JournalIndex` values. These are allocated from the local watermark and are appended at the current head of the journal, not interleaved into already-occupied indices.

REQ-JS-13: After sync, the local `last_journal_index` MUST be advanced to cover the maximum of the pre-sync local value, the pre-sync remote value, and any freshly allocated indices from resolution or conservative appends. This ensures the watermark reflects all indices present on any synchronized host.

---

## Physical journal convergence

Synchronization must bring journal storage into physical agreement.

REQ-JS-14: After synchronization completes, for every `JournalIndex` `i`, all synchronized hosts MUST agree that `rendered/r/journal/i` is either:

- the **same** `JournalEntry` value (byte-for-byte identical), or
- **absent** (compacted or deleted on that host).

The "absent" case allows for compaction and deletion. What is NOT allowed is host A having one `JournalEntry` at index `i` while host B has a different `JournalEntry` at the same index `i`.

### Resolving divergent indices

REQ-JS-15: If synchronization discovers that two hosts have different `JournalEntry` values at the same `JournalIndex` `i`, that index is poisoned. Both conflicting entries MUST be deleted from index `i`. Any still-relevant possible changes described by the conflicting entries MUST be appended at fresh `JournalIndex` values greater than `max(local.last_journal_index, remote.last_journal_index)` computed before allocating the re-appended entries. This may produce duplicate or redundant possible changes but avoids silent missed changes.

This is the safer rule: choosing one authoritative entry to remain at the original index could make a stored token that had already consumed the losing entry accidentally skip the winning entry. Poisoning the index and re-appending avoids that risk.

REQ-JS-16: Gaps produced by poisoned indices follow REQ-JC-04 (sparse storage is tolerated).

### Sync order

REQ-JS-17: Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. This does not imply that `JournalIndex` order is a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule (REQ-JS-15).

### Remote compaction

REQ-JS-18: During sync, a host MAY transmit the set of `JournalIndex` values it has compacted away. The receiving host MAY then compact the corresponding entries from its own journal storage, provided doing so satisfies the compaction rules in `incremental-graph-journal-compaction.md`.

---

## Eventual consistency (logical)

REQ-JS-19: After all hosts have completed synchronization and no further graph mutations occur, the following must hold:

1. **Graph state converges**: For every node key, all hosts agree on the node's value (or absence).
2. **Physical journal converges**: Per REQ-JS-14, all hosts agree on each index's state.
3. **Journal-observable behavior converges**: Any host calling `graph.possibleMaybeChanges` after convergence sees a consistent set of possible changes representing the converged graph state.

---

## Host identity and journal consumers

REQ-JS-20: Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Interaction with compaction

Sync operates on the journal storage that exists at sync time. Compaction may have removed entries before sync. This is safe because:

1. Compaction removes only entries that are no longer needed for correctness (see `incremental-graph-journal-compaction.md`).
2. Conflict resolution uses timestamps from surviving journal entries or from node metadata (the `timestamps` sublevel records creation and modification times per node identifier).
3. If a node's journal entry has been compacted away, the node's modification timestamp from the `timestamps` sublevel is used as the authoritative comparison value.

REQ-JS-21: During conflict resolution, if a node's journal entry no longer exists, sync MUST use the node's modification timestamp from the `timestamps` sublevel. If neither exists (should not happen for a materialized node with identifier-lookup integrity), sync MUST treat the node's timestamp as `0` (earliest possible) for conflict comparison purposes.
