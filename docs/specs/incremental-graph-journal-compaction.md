# IncrementalGraph Journal Compaction

## Purpose

This document specifies how journal storage may be compacted — which entries may be removed, what invariants must be preserved, and how compaction interacts with the `graph.possibleMaybeChanges` API.

Compaction is a maintenance operation. It reduces journal storage size by removing journal entries. Under the weak semantics of `possibleMaybeChanges`, removed entries are simply absent from future scans; their removal does not invalidate `PossibleNodeChange` tokens that reference compacted-away positions. Compaction may remove journal entries while preserving index/watermark invariants. Journal queries tolerate sparse storage by skipping absent entries and never reconstructing deleted entries.

**Compaction scope and stored-cursor safety.** This PR specifies only same-process, in-memory journal tokens (see `incremental-graph-journal-types.md`). Since tokens are not persisted across process restarts, compaction does not need to guarantee long-lived cursor validity. A future spec may define checkpoint/lease-based compaction safety for persistent stored cursors; this PR does not specify such a mechanism.

**Baseline scans and compaction.** A baseline scan starts from the first journal entry, so it yields only surviving journal entries. This is the natural consequence of the baseline being less than any real journal index combined with sparse journal storage after compaction.

---

## Compaction rules

### Index preservation

REQ-JC-01: Compaction MUST NOT reuse `JournalIndex` values. Once an index has been allocated and committed, it is permanently retired, even if the journal entry at that index is later removed by compaction.

REQ-JC-02: Compaction MUST NOT decrease `last_journal_index`. The watermark reflects the greatest index ever allocated, not the greatest index currently storing data.

REQ-JC-03: Compaction MUST NOT renumber journal entries. If compaction removes entry at index `n`, the surrounding entries at indices `n-1` and `n+1` keep their original indices. No index shifting is permitted.

### Sparse storage

REQ-JC-04: Compaction MAY leave sparse journal storage — missing entries at some index positions. The journal storage layer and query code MUST tolerate missing entries (see REQ-JA-04).

REQ-JC-05: After compaction, scanning the journal index sequence MUST NOT fail or error when encountering a missing index. The scanner MUST skip missing entries and continue to the next available index.

### Quota-based compaction

Implementations MAY apply a quota or retention window to limit journal growth, for example:

- Retain only entries newer than a configurable age threshold.
- Retain at most `M` entries per node key, keeping only the most recent.
- Retain at least one entry per still-materialized node to support sync conflict resolution.

This specification does not mandate a specific quota policy. Any policy is valid as long as it satisfies the requirements in this document.

---

## Entries eligible for removal

### Redundant entries for the same node

REQ-JC-06: Compaction MAY remove older journal entries when a newer entry exists for the same node key.

REQ-JC-07: Compaction MUST NOT remove the only surviving `add` or `edit` entry for a materialized node. At least one `add` or `edit` entry must survive for each materialized node key so that journal evidence remains for sync correctness and journal-query safety. Compaction MAY remove older or redundant entries for the same node when a newer `add`, `edit`, or `invalidate` entry survives, provided the resulting surviving entries preserve enough journal evidence for sync convergence.

### Entries for deleted nodes

REQ-JC-08: Compaction MAY remove all journal entries for a node that has been deleted (whose `NodeIdentifier` no longer exists in the graph state) once the deletion is sufficiently old or once all hosts in the sync mesh are known to have processed the deletion. The exact policy for determining "sufficiently old" is implementation-defined.

### Interaction with synchronization

REQ-JC-09: Compaction MAY remove journal entries even when synchronization is pending. Sync does not use `timestamps` sublevel records as a replacement for missing journal entries. Instead, sync uses only surviving journal entries for conflict comparison. Absent journal entries are treated as "no journal evidence" rather than falling back to node timestamps. See `incremental-graph-journal-sync.md` for the sync conflict-resolution rules.

REQ-JC-10: Compaction is safe for synchronization correctness as long as the surviving journal entries (if any) plus the sync conflict rules produce correct convergence. Sync does not require journal entries that do not exist.

---

## `graph.possibleMaybeChanges` behavior after compaction

REQ-JC-11: `graph.possibleMaybeChanges` skips absent entries. If an entry's payload was deleted by compaction, it is gone and MUST NOT be reconstructed or re-yielded. The iterator silently advances past absent positions.

REQ-JC-12: `graph.possibleMaybeChanges` NEVER reconstructs deleted entries.

### Queries and absent entries

REQ-JC-13: When the `since` argument is a `PossibleNodeChange`, the journal module widens it to `PrivatePossibleNodeChange` and scans indices strictly greater than the widened private change's `index`. Missing entries are skipped. Deleted entries are not reconstructed. The query continues from the private index embedded in the `since` value, tolerating absent entries.

REQ-JC-14: When a `BaselinePossibleNodeChange` is supplied as `since`, scanning starts from the first journal entry. Compaction affects the result only by determining which entries still exist.

---

## What compaction MUST NOT do

REQ-JC-15: Compaction MUST NOT remove the `last_journal_index` metadata from `rendered/r/global/last_journal_index`.

REQ-JC-16: Compaction MUST NOT rewrite or reinterpret the `time` field of surviving journal entries.

REQ-JC-17: Compaction MUST NOT change the `action` field of surviving journal entries.

REQ-JC-18: Compaction MUST NOT merge entries from different `creator` hosts for the same node key. Each surviving entry retains its original `creator`.

---

## Out of scope

A future spec may define checkpoint/lease-based compaction safety for long-lived stored cursors. This PR does not specify such a mechanism.

---

## Implementation strategy (non-normative)

This is only a storage-thinning strategy under the current limited compaction semantics. It does not establish safety for long-lived stored cursors.

A suggested compaction approach:

1. Maintain a per-node-key "latest journal index" mapping (volatile or checkpointed).
2. During compaction, iterate all journal entries. For each node key, keep only the latest entry plus, optionally, the earliest `add` entry if it differs from the latest.
3. Remove all other entries for that node key.
4. For deleted nodes, remove all entries if the deletion is older than the retention window.
5. Update no metadata except the journal storage itself.
