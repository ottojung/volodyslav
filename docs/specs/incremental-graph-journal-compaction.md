# IncrementalGraph Journal Compaction

## Purpose

This document specifies how journal storage may be physically compacted and what invariants must be preserved. The central invariant is:

> Physical compaction MUST have no observable effect on `possibleMaybeChanges`.

Physical compaction reduces storage usage. It may also reduce scan work internally, but it must not alter journal-query semantics. The only externally observable effect of physical compaction is reduced storage size.

Compaction relies on the `logicalJournalView(journal, H)` defined in `incremental-graph-journal-types.md`. Physical compaction removes entries that are not logically required through its captured bound, never entries that are.

**Compaction scope and stored-cursor safety.** This PR specifies only same-process, in-memory journal tokens (see `incremental-graph-journal-types.md`). Since tokens are not persisted across process restarts, compaction does not need to guarantee long-lived cursor validity. A future spec may define checkpoint/lease-based compaction safety for persistent stored cursors; this PR does not specify such a mechanism.

**Baseline scans and compaction.** A baseline scan returns the logical journal
view through its fixed bound `H`. Entries outside that view are not returned,
whether or not physical compaction has removed them.

---

## Concurrency: garden and darkroom coordination

Compaction structurally mutates established journal positions. It must close the garden, acquire a fixed compaction bound, perform analysis and deletion determination under exclusive garden access, and acquire darkroom only for the atomic durable batch.

### Protocol

REQ-JC-CONC-01: Compaction MUST call `closeGarden` before selecting the active replica. `closeGarden` is held for the entire analysis and durable mutation, not just the final commit.

REQ-JC-CONC-02: After acquiring `closeGarden`, compaction reads `last_journal_index = H` from the selected replica, establishing a fixed compaction bound.

REQ-JC-CONC-03: Compaction determines deletions only among positions `≤ H`. It MUST NOT modify entries appended after `H`.

REQ-JC-CONC-04: For the atomic durable deletion batch, compaction acquires darkroom inside `closeGarden`.

REQ-JC-CONC-05: Compaction MUST NOT decrease or overwrite a concurrently advanced `last_journal_index`.

REQ-JC-CONC-06: Ordinary append-only journal growth MAY continue while the garden is closed. Those appends use indices greater than `H` and are outside the compacted prefix.

REQ-JC-CONC-07: After the durable batch commits and darkroom is released, compaction reopens the garden.

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

Implementations MAY apply a quota to limit journal growth. A quota controls when compaction runs and whether all or only some currently removable entries are deleted. A quota never changes which entries are logically required.

Any quota policy is valid as long as it satisfies the requirements in this document. Quota policies that constrain by age (e.g., "retain only entries newer than 24 hours") must explicitly exempt logically required entries.

---

## Entries eligible for removal

For a compaction run with captured bound `H`, compute `logicalJournalView(journal, H)` — the same logical projection used by `possibleMaybeChanges` and journal reconciliation (see `incremental-graph-journal-sync.md`).

### Logically required entries

REQ-JC-06: Physical compaction MUST preserve every entry that is in `logicalJournalView(journal, H)`. An entry is logically required when its semantic key and category make it a retained entry through `H`.

REQ-JC-07: Physical compaction MAY delete any physically present entry at an index ≤ `H` that is NOT in `logicalJournalView(journal, H)`.

REQ-JC-07a: Physical compaction MUST leave positions greater than `H` untouched.

REQ-JC-07b: Physical compaction MUST leave deleted positions absent. It MUST NOT renumber surviving entries. It MUST NOT decrease `last_journal_index`.

### Two-category rule

The logical retention rules replace the older collection of separate retention policies. For each semantic node key:

1. **State/lifecycle category** (`add`, `edit`, `delete`): preserve only the greatest-index entry through `H`. Physical compaction may remove older state entries.

2. **Freshness category** (`invalidate`, `validate`): preserve only the greatest-index entry through `H` (when one exists). Physical compaction may remove older freshness entries.

These categories are independent: a newer state entry does not allow removal of
the latest freshness entry; a newer freshness entry does not allow removal of
the latest state entry.

### Quotas

REQ-JC-08: A quota or retention policy may decide how aggressively physically removable entries are deleted. It may also defer or skip some deletion for efficiency. It MUST NOT remove a logically required entry as defined by `logicalJournalView(journal, H)`. It MUST NOT change the output of `possibleMaybeChanges`.

### Deleted keys

A journal-deleted key is a semantic key whose latest state entry through `H` has
action `delete`. Deleted keys follow the same two-category logical retention
rule: the latest state entry (the `delete`) and latest freshness entry (when
one exists) are logically required. See the deleted-key example in C7.

### Interaction with synchronization

REQ-JC-09: Compaction MAY remove entries outside `logicalJournalView(journal,
H)` even when synchronization is pending. Synchronization selects evidence from
the source logical view and does not use `timestamps` sublevel records as a
replacement for journal evidence. See `incremental-graph-journal-sync.md`.

REQ-JC-10: Compaction is safe for synchronization because it preserves every
entry in the logical journal view used for conflict selection. Synchronization
does not require entries outside that view.

---

## Observational equivalence

REQ-JC-11: Let `S` be a journal state and let `C(S)` be any result of a conforming physical compaction of `S`. For the same active replica, fixed bound, `since` token, and `NodeFilter`:

```
possibleMaybeChanges(S, since, to) = possibleMaybeChanges(C(S), since, to)
```

The returned arrays must contain the same logical entries in the same order. The only externally observable effect of physical compaction is reduced storage usage. It may also reduce scan work internally, but it must not alter journal-query semantics.

This is an immediate consequence of both compaction and `possibleMaybeChanges` using the same `logicalJournalView(journal, H)`. The query already suppresses every entry that compaction is permitted to remove.

### Compaction lag

Compaction may overlap ordinary appends because it holds `closeGarden` but not `holidayActivity`.

Example:

```
compaction captures H = 5
index 5 = edit X
```

The compaction must preserve index 5 because it is the latest state entry through its bound.

Later, an ordinary append commits:

```
index 7 = edit X
```

The physical journal may temporarily contain both indices 5 and 7.

A query through `H = 7` returns only index 7 — the later state entry supersedes index 5 in the logical view.

A later compaction may delete index 5. The query result before and after deleting index 5 is identical.

This is the main reason `possibleMaybeChanges` must perform logical compaction independently of whether physical compaction has run.

---

## `graph.possibleMaybeChanges` behavior after compaction

REQ-JC-12: `graph.possibleMaybeChanges` skips absent entries. An entry physically
deleted by conforming compaction was already outside the logical journal view,
was not returned before deletion, and is not reconstructed after deletion.
Therefore its removal does not change the returned array.

REQ-JC-13: `graph.possibleMaybeChanges` NEVER reconstructs deleted entries.

### Cursor semantics after compaction

REQ-JC-14: When the `since` argument is a `PossibleNodeChange`, the journal module widens it to `PrivatePossibleNodeChange` and scans indices strictly greater than the widened private change's `index`. Missing entries are skipped. Deleted entries are not reconstructed. The query continues from the private index embedded in the `since` value, tolerating absent entries.

A `PossibleNodeChange` cursor may refer to an entry that is later physically deleted by compaction. That is valid because the runtime token retains its private journal index and the next query scans strictly after that index. It does not need the old payload to remain in storage.

Example:

```
index 1 = add X
index 5 = edit X
index 8 = edit X
```

A query through `H = 5` may return index 5 as a `PossibleNodeChange`. Later index 8 is appended, and physical compaction may delete indices 1 and 5. A subsequent query with `since = token pointing to index 5` and `H = 8` returns `index 8 = edit X`. The cursor remains usable even though its backing entry is physically absent. Payload reconstruction is not required.

REQ-JC-15: When a `BaselinePossibleNodeChange` is supplied as `since`, the query
returns the logical journal view through `H`. An entry removed by conforming
compaction was excluded from that view before deletion and remains absent rather
than being reconstructed, so physical removal does not change the result.

---

## What compaction MUST NOT do

REQ-JC-16: Compaction MUST NOT remove the `last_journal_index` metadata from `rendered/r/global/last_journal_index`.

REQ-JC-17: Compaction MUST NOT rewrite or reinterpret the `time` field of surviving journal entries.

REQ-JC-18: Compaction MUST NOT change the `action` field of surviving journal entries.

REQ-JC-19: Compaction MUST NOT merge entries from different `creator` hosts for the same node key. Each surviving entry retains its original `creator`.

---

## Out of scope

A future spec may define checkpoint/lease-based compaction safety for long-lived stored cursors. This PR does not specify such a mechanism.

A conforming compaction cannot remove a deleted key's latest state entry or its
latest freshness entry when one exists, because either removal would change
`possibleMaybeChanges`. Only an incompatible future API revision could redefine
that logical view.

---

## Implementation strategy (non-normative)

This is only a storage-thinning strategy under the current limited compaction semantics. It does not establish safety for long-lived stored cursors.

A suggested compaction approach:

1. Compute `logicalJournalView(journal, H)` — retain, per semantic node key:
   - the greatest-index state/lifecycle entry (`add`, `edit`, or `delete`);
   - the greatest-index freshness entry (`invalidate` or `validate`), when one exists.
2. Preserve every entry in that logical view. Remove all other physically present entries through `H`.
3. A quota policy may decide whether to remove all or some of the currently
   physically removable entries, or to skip a compaction run entirely. It must
   not remove logically required entries.

---

## Testable scenarios

### C1 — Physical compaction is invisible

Before compaction:

```
index 1 = add X
index 4 = edit X
index 6 = invalidate X
index 9 = validate X
```

Baseline query returns:

```
index 4 = edit X
index 9 = validate X
```

Physical compaction deletes indices 1 and 6. The same baseline query still returns exactly:

```
index 4 = edit X
index 9 = validate X
```

### C2 — Redundant entries hidden before compaction

Using the same physical journal as C1, with no compaction run ever executed, the baseline query still returns only indices 4 and 9. Logical compaction suppresses the older entries even when physical compaction has not deleted them.

### C3 — State and freshness are independent

```
index 1 = add X
index 3 = invalidate X
index 5 = edit X
index 7 = validate X
```

Baseline query returns:

```
index 5 = edit X
index 7 = validate X
```

The later state event does not suppress the freshness event. The later freshness event does not suppress the state event.

### C4 — Cursor after superseded state

```
index 2 = add X
index 5 = edit X
index 8 = edit X
```

Baseline query through `H = 8` returns `index 8 = edit X`.

With `since = index 5`, `H = 8`, returns `index 8 = edit X`.

With `since = index 8`, `H = 8`, returns nothing for X.

### C5 — Cursor entry physically removed

```
index 1 = add X
index 5 = edit X
index 8 = edit X
```

A query through `H = 5` returns index 5 as a `PossibleNodeChange`. Later, index 8 is appended. Physical compaction deletes indices 1 and 5. A subsequent query with `since = token for index 5` (whose backing entry was physically deleted) and `H = 8` returns `index 8 = edit X`. The cursor remains usable even though its backing entry is physically absent.

### C6 — Compaction lag

Compaction captures `H = 5` and preserves `edit X` at index 5.

A later ordinary append commits `edit X` at index 7. The physical journal temporarily contains both indices 5 and 7.

A query through `H = 7` returns only index 7 (the later state entry). A later compaction deletes index 5. The query result before and after deleting index 5 is identical.

### C7 — Deleted key

```
index 2  = add X
index 4  = invalidate X
index 6  = validate X
index 9  = delete X
```

Baseline query returns:

```
index 6  = validate X
index 9  = delete X
```

Physical compaction may remove indices 2 and 4 but MUST preserve indices 6 and 9. The latest freshness and latest state entries for the deleted key remain in the logical view.

### C8 — Captured prefix is independent of current graph state

```
H = 5
index 5 = delete X

later:
index 6 = add X
```

A compaction that captured `H = 5` preserves index 5 because it is the latest
state entry through that bound. It does not consult or reinterpret the prefix
using the now-materialized graph state after index 6 commits.
