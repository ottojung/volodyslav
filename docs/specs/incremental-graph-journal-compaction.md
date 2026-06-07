# IncrementalGraph Journal Compaction

## Purpose

This document specifies how journal storage may be compacted — which entries may be removed, what invariants must be preserved, and how compaction interacts with synchronization and the `possibleMaybeChanges` API.

Compaction is a maintenance operation. It reduces journal storage size by removing entries that are no longer needed for correctness while preserving the safety of journal queries.

---

## Compaction rules

### Index preservation

REQ-JC-01: Compaction MUST NOT reuse `JournalIndex` values. Once an index has been allocated and committed, it is permanently retired, even if the journal entry at that index is later removed by compaction.

REQ-JC-02: Compaction MUST NOT decrease `last_journal_index`. The watermark reflects the greatest index ever allocated, not the greatest index currently storing data.

REQ-JC-03: Compaction MUST NOT renumber journal entries. If compaction removes entry at index `n`, the surrounding entries at indices `n-1` and `n+1` keep their original indices. No index shifting is permitted.

### Sparse storage

REQ-JC-04: Compaction MAY leave sparse journal storage — missing entries at some index positions. The journal storage layer and query code MUST tolerate missing entries (see REQ-JA-08).

REQ-JC-05: After compaction, scanning the journal index sequence must not fail or error when encountering a missing index. The scanner must skip missing entries and continue to the next available index.

### Quota-based compaction

Implementations MAY apply a quota or retention window to limit journal growth, for example:

- Retain only entries newer than a configurable age threshold (e.g., entries older than `N` days may be removed).
- Retain at most `M` entries per node key, keeping only the most recent.
- Retain at least one entry per still-materialized node to support sync conflict resolution.

This specification does not mandate a specific quota policy. Any policy is valid as long as it satisfies the requirements in this document.

---

## Entries eligible for removal

### Redundant entries for the same node

REQ-JC-06: Compaction MAY remove older journal entries when a newer entry exists for the same node key. For example, if a node has entries at indices 10 (`add`), 15 (`edit`), and 20 (`edit`), compaction MAY remove entries 10 and 15, keeping only entry 20. The key constraint is:

REQ-JC-07: Compaction MUST NOT remove an `add` entry if no later `add` or `edit` entry exists for the same node key, UNLESS the node is no longer materialized (in which case REQ-JC-08 applies).

Rationale: `possibleMaybeChanges` consumers scanning forward must see at least one entry per materialized node whose position is at or after a supplied `since` token. If compaction removes all entries for a materialized node, a consumer starting from a `since` token before those entries might miss the node entirely.

### Entries for deleted nodes

REQ-JC-08: Compaction MAY remove all journal entries for a node that has been deleted (whose `NodeIdentifier` no longer exists in the graph state) once the deletion is sufficiently old or once all hosts in the sync mesh are known to have processed the deletion. The exact policy for determining "sufficiently old" is implementation-defined.

### Interaction with synchronization

REQ-JC-09: Compaction MUST NOT remove journal entries that are still needed for pending or in-progress synchronization. If sync needs a journal entry to resolve a conflict (e.g., to compare timestamps for a node key), that entry must not be removed before sync completes.

REQ-JC-10: If a node's journal entry has been compacted away before sync, sync uses the node's `timestamps` sublevel record for conflict comparison (see REQ-JS-18). This fallback means compaction of journal entries is safe for sync correctness as long as the `timestamps` sublevel records are preserved.

---

## Compaction and `possibleMaybeChanges` safety

The most important constraint on compaction is that it must not break `possibleMaybeChanges`.

REQ-JC-11: Compaction MAY delete only entries whose deletion preserves future `possibleMaybeChanges` safety for all stored `PossibleNodeChange` tokens. Concretely: if deleting an entry would make a stored `PossibleNodeChange` token unsafe (because a consumer holding that token could no longer correctly resume), that entry MUST NOT be compacted.

REQ-JC-12: Compaction is responsible for ensuring that any `PossibleNodeChange` token a consumer might store remains usable. The preferred implementation strategy is:

1. Track the journal index of every `PossibleNodeChange` token that consumers may store.
2. During compaction, only delete entries whose indices are definitively earlier than all known stored tokens.
3. If this constraint is infeasible (because the system cannot enumerate all stored tokens), apply a retention floor: never delete entries newer than a safety threshold that exceeds the maximum plausible token age.

REQ-JC-13: `possibleMaybeChanges` MUST NOT be required to reconstruct or re-yield entries whose payloads have been compacted away. If an entry is gone, it is gone. The query implementation safely skips compacted positions by resuming from the next available index. The correctness of that resumption depends on compaction having not deleted entries that stored tokens reference.

REQ-JC-14: The `baselinePossibleNodeChange()` sentinel is inherently safe from compaction because it does not reference any specific journal index. It conceptually represents "before any entry." Compaction cannot invalidate it.

---

## What compaction MUST NOT do

REQ-JC-15: Compaction MUST NOT remove the `last_journal_index` metadata from `rendered/r/global/last_journal_index`.

REQ-JC-16: Compaction MUST NOT rewrite or reinterpret the `time` field of surviving journal entries.

REQ-JC-17: Compaction MUST NOT change the `action` field of surviving journal entries.

REQ-JC-18: Compaction MUST NOT merge entries from different `creator` hosts for the same node key. Each surviving entry retains its original `creator`.

---

## Implementation strategy (non-normative)

A suggested compaction approach:

1. Maintain a per-node-key "latest journal index" mapping (volatile or checkpointed).
2. During compaction, iterate all journal entries. For each node key, keep only the latest entry plus, optionally, the earliest `add` entry if it differs from the latest.
3. Remove all other entries for that node key.
4. For deleted nodes, remove all entries if the deletion is older than the retention window.
5. Update no metadata except the journal storage itself.

This strategy satisfies all requirements while keeping compaction simple and predictable.
