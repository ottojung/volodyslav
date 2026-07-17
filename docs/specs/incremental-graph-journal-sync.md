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
eventId.kind = "sync"
eventId.creator = syncAuthor
```

This is independent of which host initiated the operation.

REQ-JS-05: For each generated event, construct a complete `SyncEventDerivation`:

1. Determine its perspective-free `reason` (see SyncEventReason in incremental-graph-journal-types.md).
2. Gather the exact causal journal events. Duplicate cause IDs are removed.
3. Sort causes canonically (by creator then originIndex for origin events, or by creator then digest for sync events).
4. Set `creator = syncAuthor`.
5. Set `time = maximum time` among its causal journal events:

   - `materialization-adoption` uses the winning `add` or `edit` event time.
   - `value-adoption` uses the winning `add` or `edit` event time.
   - `identifier-conflict-delete` uses the maximum time among the winning and losing value-evidence events.
   - `identifier-conflict-winner-edit` uses the maximum time among the winning and losing value-evidence events.
   - `deletion-adoption` uses the winning remote `delete` event time.

Every generated sync event MUST have at least one causal journal event. If the implementation reaches a case requiring a generated event but has no journal cause, it is a separate unsupported/no-evidence case — do not fall back to graph timestamps or wall clock.

REQ-JS-06: After constructing the `SyncEventDerivation`, compute its canonical serialization and SHA-256 digest (see Canonical serialization). The derived event's identity is:

```
eventId = {
    kind: "sync",
    creator: syncAuthor,
    digest: sha256(canonicalSerialize(derivation)),
}
```

The digest is a 64-character lowercase hexadecimal string. All hosts MUST produce identical bytes for the same derivation. The event now has a complete, deterministic identity before any physical position is assigned.

Construct the complete unpositioned `JournalEntry` including `syncDerivation`. Deduplicate it against:
- other generated events in the same merge (by identity);
- retained established events (by identity);
- displaced existing events (by identity).

Only after this does it participate in fresh-event ordering and receive a physical index (see Fresh-event collection stages).

The same complete event bytes are then part of the canonical target applied to all participants.

### Canonical serialization

Define a versioned canonical byte encoding for serializing `SyncEventDerivation`. All hosts must produce identical bytes for the same derivation.

**Format (conceptual):**

```
sync-journal-event-v1
creator=<hostname string>
reason=<reason string>
action=<action string>
key=<NodeKeyString>
id=<NodeIdentifier string>
time=<base-10 integer timestamp>
causes=<ordered length-prefixed canonical event-id encodings>
```

Each field is encoded as `key=value` terminated by newline (`\n`). The `causes` field uses length-prefixed encoding: the count as a base-10 integer, then each event ID encoding.

**Canonical event-ID encoding:**

For origin event IDs:
```
origin-v1
creator=<hostname>
originIndex=<base-10 integer>
```

For sync event IDs:
```
sync-v1
creator=<hostname>
digest=<64 lowercase hex characters>
```

**SHA-256 digest:**

```
eventId = {
    kind: "sync",
    creator: derivation.creator,
    digest: sha256(canonicalSerialize(derivation)),
}
```

- SHA-256 is applied to the exact canonical byte encoding.
- The digest is 64 lowercase hexadecimal characters.
- Event identity can be calculated before journal-position assignment.
- Synchronization validates an existing derived event by recomputing the digest from its persisted `syncDerivation`.
- Digest mismatch is a journal-integrity error. The operation aborts without graph or journal mutation.

---

## Journal entries produced by sync

REQ-JS-07: If synchronization changes canonical graph state, sync MUST make that change visible as a journal entry in the canonical target. Each generated event is authored by `syncAuthor` and its `SyncEventDerivation` is fully constructed (REQ-JS-05, REQ-JS-06). Specifically:

- **value-adoption**: An `edit` journal entry is included when conflicting materialized states resolve to one canonical value.
- **materialization-adoption**: An `add` journal entry is included when the canonical graph target contains a node absent from one input.
- **deletion-adoption**: A `delete` journal entry is included when canonical conflict resolution selects deletion.
- **identifier-conflict-delete**: A `delete` entry is included for the losing identifier.
- **identifier-conflict-winner-edit**: An `edit` entry is included for the winning identifier/value after identifier conflict.

REQ-JS-08: Sync MUST NOT omit a journal entry that would be necessary for later `graph.possibleMaybeChanges` queries to observe a material graph change.

---

## Delete entries from conflict resolution

### Conflicting identifier allocation

REQ-JS-09: When two hosts independently allocate `NodeIdentifier` values for the same node key, one identifier loses based on timestamp and identifier tie-breaking (REQ-JS-01, REQ-JS-02). The canonical target includes two generated events:

- A `delete` entry with `reason: "identifier-conflict-delete"` for the losing identifier's node key (author: `syncAuthor`, time: max causal time among winner and loser value evidence, per REQ-JS-05).
- An `edit` entry with `reason: "identifier-conflict-winner-edit"` for the winning identifier's value (author: `syncAuthor`, time: max causal time among winner and loser value evidence, per REQ-JS-05).

### Deletion adoption

REQ-JS-10: If one host has a surviving `delete` journal entry for a node key that the other host has materialized:

- Compare the `delete` entry's `time` against the materialized node's latest surviving `add` or `edit` journal entry time.
- If the `delete` time is later, the deletion wins in the canonical target. A `delete` entry with `reason: "deletion-adoption"` (author: `syncAuthor`, time: `delete` entry time) is included as a sync-generated event.
- If the latest `add` or `edit` entry time is later, the node is preserved in the canonical target. No `delete` is included.

---

## Immutable synchronization revision

Synchronization produces one immutable canonical revision `R`. The revision is never modified after commitment.

### Fixed inputs

`canonicalMerge(A, B)` takes two fixed committed revisions:

- `A`: the local committed replica revision.
- `B`: the remote committed replica revision.

A revision includes graph state, journal state, watermark, and stable host identity metadata. Changes committed after either selected input revision are not part of this merge.

### Immutable output

The result is one immutable canonical synchronization revision `R` containing:

- canonical graph target (for every conflicting node key, the winning graph state);
- canonical journal prefix (for every numeric position through P, the resolved state);
- canonical fresh event list (deterministically ordered);
- all generated payloads and event IDs;
- final watermark (P + n).

Once `R` is committed, its bytes never change. It may be copied or replayed exactly. It is not recomputed with different creators, timestamps, IDs, or positions.

### Adoption

A participant still at input revision `A` or `B` may adopt `R`. A participant with post-input changes MUST NOT overwrite them by blindly installing `R`. Those changes are descendants or concurrent revisions and participate in a later canonical merge with `R`.

### Convergence point

A synchronization convergence point for revisions `A` and `B` exists when participants have adopted or descended from the same immutable canonical result `R`. Distributed atomic installation is not required; the same `R` is propagated byte-for-byte.

### The canonical merge function

The pairwise journal reconciliation is defined as:

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

REQ-JS-11: `canonicalMerge` MUST be deterministic, symmetric, and commutative:

```
canonicalMerge(A, B) = canonicalMerge(B, A)
```

REQ-JS-12: `canonicalMerge` MUST be idempotent for already-converged inputs:

```
canonicalMerge(T, T) = T
```

where `T` is an already converged target. Merging the already converged target with itself creates no new sync event, no new journal index, and no watermark change.

### Pairwise versus multi-host convergence

`canonicalMerge` is not required by this specification to be associative. Therefore:

```
canonicalMerge(canonicalMerge(A, B), C)
```

may initially differ physically from:

```
canonicalMerge(A, canonicalMerge(B, C))
```

Multi-host convergence is achieved through fair repeated synchronization of immutable revisions after graph activity becomes quiescent.

REQ-JS-13: Normative eventual-convergence requirements:

- Every committed revision is eventually offered to every participating host.
- Hosts repeatedly merge divergent revisions.
- No new graph or compaction mutations occur during the convergence interval.
- Derived sync events deduplicate by deterministic derived event ID (`eventId.kind = "sync"`).
- Origin events deduplicate by origin event ID (`eventId.kind = "origin"`).
- Established absence only propagates and never reverses.
- Event relocation only moves an event to a greater physical index.
- After convergence, all heads expose identical graph and journal state.

### Partial canonical-target application

Before any participant exposes a canonical target, the target MUST be fixed completely, including: prefix states, fresh-event ordering, fresh positions, generated event payloads, generated event IDs (`eventId.kind`, `creator`, `originIndex` or `digest`), and final watermark.

REQ-JS-14: Once any participant has committed that target, retry MUST reuse the exact same target. It MUST NOT regenerate sync events with different times, creators, IDs, or positions. Recomputation is permitted only if no participant has yet committed the old target.

A synchronization session is complete only when all participants have applied that target. If one participant applies it and another does not, synchronization is incomplete. If a participant performs a new ordinary append after applying the target, that append is post-plan activity and belongs to a later reconciliation; the prior session cannot claim full current-state convergence beyond its fixed frontier.

---

## Fresh-event collection stages

Synchronization processes fresh events through six distinct stages. Every stage operates on journal entries that already have a complete, deterministic `eventId` — origin events have their identity from first commit; sync-generated events have their identity from SHA-256 digest of `SyncEventDerivation`.

### Stage A: Canonical prefix candidates

Resolve every numeric position `1 .. P` with the prefix merge. Each surviving prefix entry already has:
- payload;
- `JournalEventId`;
- numeric position.

### Stage B: Validate event identity globally

Across all input occurrences and generated candidates:

- The same `eventId` MUST map to the same immutable payload.
- For derived IDs (`kind: "sync"`), persisted `syncDerivation` MUST also match.
- Derived digest MUST validate by recomputing SHA-256 from `syncDerivation`.
- Mismatch is a journal-integrity error — abort synchronization without any graph or journal mutation.

### Stage C: Normalize positioned prefix duplicates

Consider only events that survived the per-position prefix merge. For each event ID:
- One surviving position: retain it.
- Multiple surviving positions: retain the greatest position.
- Lower surviving duplicates become established absence.

Do not include unpositioned queued events when comparing `JournalIndex`.

### Stage D: Collect unpositioned fresh events

Collect:
- Existing events displaced by poisoning.
- Existing events displaced by absence propagation and retained by relevance rules.
- Derived sync-generated events (with complete `SyncEventDerivation` and computed digest).
- Other existing events unable to retain their position.

### Stage E: Deduplicate fresh events

For each event ID:
- If the event already survives in the normalized prefix, remove it from the fresh collection.
- Otherwise retain exactly one fresh copy.
- Distinct event IDs remain distinct even with identical payloads.

### Stage F: Canonical ordering and placement

Order the resulting complete journal entries. All entries now possess a stable event ID. Allocate:

```
P + 1 .. P + n
```

### Canonical ordering for fresh entries

Use one total order for all complete fresh journal entries:

1. `time` ascending.
2. `NodeKeyString` ascending.
3. `creator` ascending.
4. Action rank: `add < edit < delete < invalidate`.
5. `NodeIdentifier` ascending.
6. `JournalEventId.kind`: `origin < sync`.
7. For origin IDs: `eventId.creator` ascending, then `eventId.originIndex` ascending.
8. For sync IDs: `eventId.creator` ascending, then `eventId.digest` ascending (lexicographic).

Because every fresh event has a complete ID before ordering, this is non-circular.

---

## Journal storage during sync

REQ-JS-15: After the prefix merge and fresh allocation, the local `last_journal_index` MUST be advanced to `P + n`, where `P = max(revalidated local last_journal_index, fixed remote last_journal_index)` and `n` is the number of freshly allocated entries. Use only `P` as the merge frontier — no separate `B` formula is needed.

---

## Physical journal convergence

Synchronization must bring journal storage into physical agreement.

### Resolving divergent indices

REQ-JS-16: If synchronization discovers that two hosts have different `JournalEntry` values at the same `JournalIndex` `i`, that index is poisoned. Both conflicting entries MUST be deleted from index `i`. Any still-relevant changes described by the conflicting entries MUST be appended at fresh `JournalIndex` values above the unified merge frontier `P`:

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

REQ-JS-17: If one synchronized host has an established journal entry at index `i` and another host has an established absence at the same index `i`, absence wins at index `i`. The present entry MUST be removed from index `i` on every host that has it. Absence at an established index may be caused by compaction, poisoning, propagated remote compaction, or any other structural deletion.

If the removed entry still carries relevant journal evidence (i.e., it is the only surviving `add` or `edit` for a materialized node key), that evidence MUST be reappended at a fresh local index before or atomically with removing the established entry. This ensures that compaction evidence rules (REQ-JC-07) and materialized-node visibility are preserved.

The same materialized-node evidence rule applies: sync MUST NOT propagate absence in a way that removes the only surviving `add` or `edit` for a materialized node unless equivalent evidence is reappended first.

### Unified physical merge algorithm

The rules above (divergent indices, present-versus-absent, remote suffix) are all special cases of one unified algorithm. This section defines that algorithm explicitly.

The algorithm computes one canonical target journal state from the two participating replica states and outputs one immutable revision `R`.

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

   If the present entry was removed by absence, queue it for fresh reappend only when required by the evidence-preservation policy (REQ-JS-22h). If two different entries are poisoned, queue both for fresh reappend.

2. **Only local has established state at `i`** (i ≤ localH, i > remoteH):

   Preserve the local state at `i` (entry or absence). Replicate it to the remote.

3. **Only remote has established state at `i`** (i > localH, i ≤ remoteH):

   The position is unestablished locally. Replicate the remote state at `i` (copy a remote entry into local position `i`, or establish local absence at `i` when the remote position is absent).

**Fresh allocation base:**

After the prefix merge, every position `1 .. P` has one canonical target state. `P` is the fresh allocation base:

```
P = max(
    revalidated local last_journal_index,
    fixed remote last_journal_index
)
```

If both replicas are mutable during the same session, use the maximum revalidated watermark across all participating replicas.

Fresh events receive indices `P + 1 .. P + n`. The final watermark is `P + n`.

After synchronization completes, for every `JournalIndex` `i`, all synchronized hosts MUST agree that `rendered/r/journal/i` is either:

- the **same** `JournalEntry` value (byte-for-byte identical), or
- **absent** (compacted or deleted on that host).

What is NOT allowed is host A having one `JournalEntry` at index `i` while host B has a different `JournalEntry` at the same index `i`.

---

### Remote suffix reconciliation

When the remote host has journal entries at indices beyond the local watermark (`remoteH > localH`), those entries belong to the **remote suffix** — positions that do not yet exist in the local journal namespace.

A remote journal position may be copied into the same numeric local position while that local position is still unestablished. A local position `i` is unestablished exactly when:

```
i > current local last_journal_index
```

An unestablished position is not an established absence. Installing remote state into an unestablished position therefore does not violate the prohibition against filling established gaps.

If the position became established locally before sync finalization (a concurrent append claimed it), sync MUST reconcile the local and remote states at `i` using the normal same-index convergence rules.

REQ-JS-18a: A remote suffix position `i` MAY be replicated at local position `i` when `i` is greater than the current committed local `last_journal_index` at darkroom finalization. Replication into an unestablished position is preservation of an existing replicated physical position, not creation of a new journal event.

REQ-JS-18b: A remote suffix position MUST NOT overwrite, fill, replace, or rewrite a position that is already established locally. If position `i` became established locally before sync finalization, sync MUST reconcile the local and remote states at `i` using the same-index convergence rules (poisoning and fresh reappend, per REQ-JS-11 through REQ-JS-16).

REQ-JS-18c: The local `last_journal_index` MUST advance to `P = max(localH, remoteH)`. After sync completes, the local host's watermark is at least as large as the remote watermark.

REQ-JS-18d: The no-race remote-suffix case is a testable scenario of the unified algorithm, not a separate normative algorithm. The unified algorithm handles it: when `closeGarden` is acquired and the remote suffix is analyzed, darkroom finalization rereads `H` and replicates unestablished remote positions according to the prefix merge rules. If a concurrent append has claimed a suffix position, the unified poisoning rules apply.

REQ-JS-18e: The concurrent-append case is an example of revalidation changing `localH` during finalization. The concurrent finalization protocol is:

1. Acquire `closeGarden` before selecting the active replica or examining established journal structure.
2. Perform reconciliation analysis while holding `closeGarden` — read remote journal entries, identify conflict positions, determine reconciliation needs. Prepare logical graph and journal effects with complete `SyncEventDerivation` and computed SHA-256 digests for generated events, without assigning fresh local indices.
3. Acquire darkroom.
4. **Revalidate all semantic evidence** used by the prepared reconciliation plan for every affected node key:

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

   This fallback exists solely to guarantee progress against a continuous stream of local appenders. Sync NEVER releases `closeGarden` during a retry.

   Revalidating only physical journal positions is insufficient. Journal positions alone do not capture late-arriving materialization facts: a node that was absent during analysis may have been materialized by a concurrent append, or a node whose latest `add`/`edit` entry sync intended to use as conflict evidence may have been superseded by a newer entry committed during analysis.

5. Re-read the current committed local `last_journal_index = H`.
6. Re-read every local journal position that the prepared reconciliation intended to delete, poison, or otherwise reason about.
7. **Compute the unified merge frontier `P = max(H, remote.last_journal_index)`**.
8. **Run the fresh-event collection stages A–F** (prefix candidates, validate identity, normalize prefix duplicates, collect unpositioned, deduplicate, and canonically order + allocate at `P + 1 .. P + n`).
9. Install structural deletions/poisoning, fresh appended entries, replicated remote suffix entries (at positions that remained unestablished), graph reconciliation state, and the final watermark `P + n` in one atomic durable batch.
10. Release darkroom.
11. Release `closeGarden` (reopen the garden).

Under this protocol, all journal-index allocation and established-position mutation happen under darkroom, serialized with ordinary durable commits. The darkroom is held only for finalization, not for the earlier analysis phase (step 2). The protocol revalidates both semantic and physical evidence during finalization.

### Evidence collection and deduplication

The fresh collection is built during Stage D of the fresh-event collection pipeline. Use event identity (`JournalEventId`), not payload equality, for deduplication.

REQ-JS-19f: The queued collection consists of:

1. Every distinct event displaced by an entry-versus-entry poisoned position.
2. Every event displaced by entry-versus-absence reconciliation that must survive under the evidence-preservation policy (REQ-JS-19h).
3. Every newly generated journal event with complete `SyncEventDerivation` and computed SHA-256 digest.
4. Any other event that the canonical target requires but that cannot remain at its original position.

REQ-JS-19g: After collecting, normalize the collection:

1. Gather every target position (both retained established positions and newly queued entries) containing each `eventId`.
2. Verify all occurrences have the same immutable payload per REQ-JT-24. For sync-derived events, also recompute digest from `syncDerivation`. If mismatch, abort — integrity violation.
3. If an event occurs at exactly one position, preserve it.
4. If it occurs at multiple positions, retain the occurrence with the greatest `JournalIndex`. Change every lower duplicate occurrence to established absence.
5. Remove any event whose `eventId` is already present in a surviving retained target position after the greatest-position resolution.
6. Deduplicate queued copies by `eventId` — the same logical event must not appear more than once in the fresh collection.
7. Preserve multiplicity between different `eventId` values, even when the entries are otherwise byte-for-byte identical. Structural payload equality MUST NOT collapse distinct events with different `eventId` values.
8. Apply the sync-induced-removal evidence policy (REQ-JS-19h).
9. Canonically order the remaining events.
10. Allocate them at `P + 1 ... P + n`.

### Canonical ordering for fresh entries

When synchronization produces multiple entries queued for fresh placement, those entries MUST be assigned to fresh positions `P + 1 .. P + n` in a canonical total order. This ensures that two hosts synchronizing the same set of evidence independently arrive at the same physical placement.

REQ-JS-19i: The canonical ordering for fresh journal entries is defined as:

1. **By `time` ascending**.
2. **By node key** (lexicographic `NodeKeyString` order).
3. **By `creator` hostname**.
4. **By `action` rank**: `add < edit < delete < invalidate`.
5. **By `NodeIdentifier`**.
6. **By `JournalEventId.kind`**: `origin < sync`.
7. For origin IDs: by `eventId.creator` ascending, then `eventId.originIndex` ascending.
8. For sync IDs: by `eventId.creator` ascending, then `eventId.digest` ascending (lexicographic).

Because every fresh event has a complete `eventId` before ordering, this is non-circular. The `eventId.kind` separates the two identity models while providing a total order.

### Still-relevant evidence for sync-induced removal

When a journal entry is removed from an established position by sync (by poisoning or absence propagation), some entries may need to survive through fresh reappend while others are genuinely obsolete. This section applies only to sync-induced removal. Compaction follows its own retention rules (see `incremental-graph-journal-compaction.md`) and never reappends removed entries.

All relevance decisions are based on the canonical graph and journal target, not on whichever host is currently called local.

REQ-JS-19h: The following kinds of evidence are "still relevant" and MUST be reappended when removed from an established position by sync:

- An `add` or `edit` entry that is the only surviving value evidence for a node that is materialized in the canonical graph target (mandatory under REQ-JC-07).
- A `delete` entry that carries the most recent timestamp for a node key that is deleted in the canonical graph target (needed for sync conflict convergence).
- An `invalidate` entry that is the only surviving journal record of a freshness downgrade for a node that is materialized in the canonical graph target and whose latest retained `add`/`edit` evidence does not subsume the invalidation.

The following kinds of evidence are NOT "still relevant" and MAY be dropped:

- Redundant `edit` entries for a node key that has a later surviving `edit` or `delete` entry.
- `invalidate` entries for a node that has a later surviving `add`, `edit`, or `delete` entry that supersedes the invalidation.
- Journal entries for a node key that has been deleted in the canonical graph target and whose deletion has been acknowledged.
- Any entry older than a retained entry for the same node key that carries equivalent or stronger evidence.

"Still relevant" is evaluated per removed entry at the time of removal.

### Garden concurrency for structural sync

Sync MUST NOT fill, replace, or rewrite entries at established journal positions (at or below the committed watermark). After publication, an established position may remain unchanged or become absent, but it must never change from absent to present and must never change from one entry value to another.

REQ-JS-20: Sync operations that make structural changes to established journal positions MUST call `closeGarden`. Structural changes are limited to:

- poisoning an existing index (making it absent);
- deleting either conflicting entry at an existing index;
- applying a remote compaction set locally;
- performing any other established-position deletion or poisoning.

Structural sync MUST NOT fill a previously absent established index, replace an established entry, or rewrite an entry's content. All new journal evidence MUST be appended at fresh indices strictly greater than `P`.

The structural sync phase MUST hold `closeGarden` through its analysis and atomic durable mutation, following the normative finalization protocol. The durable batch uses darkroom inside the garden closure.

REQ-JS-21: A purely append-only sync action that writes only fresh local indices MAY proceed without garden access. Fresh reappended entries MUST be allocated from `P + 1 .. P + n`. The allocation base `P = max(localH, remoteH)` is determined during darkroom finalization.

### Sync order

REQ-JS-22: Sync SHOULD process remote journal entries in ascending `JournalIndex` order for deterministic traversal. `JournalIndex` order is not a global causal order across hosts. Divergent same-index entries are handled by the poisoned-index rule.

### Remote compaction

REQ-JS-23: During sync, a host MAY transmit the set of `JournalIndex` values it has compacted away. The receiving host MAY then compact the corresponding entries from its own journal storage, provided doing so satisfies the compaction rules in `incremental-graph-journal-compaction.md`.

---

## Eventual consistency

REQ-JS-24: After all hosts have completed synchronization and no further graph mutations occur, the following must hold:

1. **Graph state converges**: For every node key, all hosts agree on the node's value (or absence).
2. **Physical journal converges**: All hosts agree on each index's state (same entry or absent). Any pre-existing compaction absence propagates to all hosts during convergence via the unified rule (absence wins at any established index). After convergence, no disagreement about individual journal positions remains.
3. **Journal queries are consistent with physical convergence**: After convergence, hosts that compact the same set of indices return the same set of possible changes. Hosts that independently compact different subsets after convergence may return different subsets, but no host returns a `PossibleNodeChange` at a given index that contradicts the converged journal entry for that index.

A synchronization convergence point is reached only when every participating replica has applied the same canonical target state. An implementation may physically apply the plan to replicas sequentially, but the logical target must already be fixed; the session is not converged until all participants expose that target.

### Three-host convergence scenario

This scenario demonstrates multi-host convergence through repeated pairwise reconciliation.

Initial state:
```
Host A: index 1 = add X (creator: A, originIndex: 1)
        index 2 = add Y (creator: A, originIndex: 2)
        H = 2

Host B: index 1 = add X (creator: A, originIndex: 1)
        index 2 = edit Y (creator: B, originIndex: 1)
        H = 2

Host C: index 1 = add Z (creator: C, originIndex: 1)
        H = 1
```

Step 1 — A and B merge (canonicalMerge(A, B)):
- Index 1: both have same add X → preserve.
- Index 2: A has add Y (creator A), B has edit Y (creator B).
  Different entries → poison index 2.
  P = max(2, 2) = 2.
  Stage A-F: both Y events queued, deduplicated by eventId (they are distinct origin events).
- Generated sync events: identifier-conflict-winner-edit, identifier-conflict-delete.
  Each gets a SyncEventDerivation with syncAuthor = lexicographically smaller(A, B).
  SHA-256 digests computed from derivations.
- Fresh positions 3 and 4+.

After A-B merge, R_AB is the canonical target. Both A and B adopt R_AB.

Step 2 — B and C merge (canonicalMerge(B_after_AB, C)):
B now has R_AB's journal layout. C has a different layout.
- The unified algorithm resolves all positions through P = max(B.H, C.H).
- Origin events deduplicate by (creator, originIndex).
- Sync-derived events deduplicate by (creator, digest).
- Absences propagate monotonically.
- The resulting revision R_BC is applied to both B and C.

Step 3 — A and B merge again (canonicalMerge(A_after_AB, B_after_BC)):
A has R_AB, B has R_BC. These are different immutable revisions.
- The unified algorithm resolves divergence again.
- Because all sync-derived events have deterministic SHA-256 digests, identical effects produce identical event IDs and deduplicate.
- Event relocation only moves entries to greater indices.
- The result R_ABC must be the same as if the order were A→C→B or any other sequence of pairwise merges, after convergence.

Verification:
- No sync-derived notification is generated twice for the same effect (identical SyncEventDerivation → identical digest → deduplication by eventId).
- Identical derived effects have identical digests.
- Physical relocation terminates at one shared layout.
- No event moves backward to a lower index.

---

## Host identity and journal consumers

REQ-JS-25: Callers of `graph.possibleMaybeChanges` MUST NOT be required to understand or inspect host identities (`Hostname` values) or raw journal indices (`JournalIndex` values). Host identity is a journal-internal concern used only during synchronization.

The `PossibleNodeChange` type intentionally excludes `Hostname` and `JournalIndex` from its public fields. Consumers see only `nodeName`, `bindings`, `action`, and `time`.

---

## Interaction with compaction

Sync operates on the journal storage that exists at sync time. Compaction may have removed entries before sync.

REQ-JS-26: Sync uses only surviving journal entries for conflict comparison. Absent journal entries are treated as "no journal evidence" — sync MUST NOT fall back to the `timestamps` sublevel as a replacement for missing journal entries. If no journal entry exists for a node key, sync uses its remaining available evidence (e.g., the fact of materialization and the node's identifier allocation) for conflict-resolution decisions according to the rules in this document.

REQ-JS-27: Compaction MUST NOT remove the only surviving `add` or `edit` entry for a materialized node (see REQ-JC-07). This ensures sync always has at least one journal-backed timestamp per materialized node for conflict comparison. If compaction adheres to this rule, the "no journal evidence" case can only occur for nodes that were deleted or dematerialized on all synchronized hosts before compaction.

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
index 3 = event X (eventId = { kind: "origin", creator: A, originIndex: 3 })
index 8 = event X (eventId = { kind: "origin", creator: A, originIndex: 3 })
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

### T9 — Same event ID, different payload (integrity violation)

```
Host A contains eventId X (kind: "origin", creator: A, originIndex: 5) with payload E
Host B contains eventId X with payload F
E != F (different action, id, key, time, or creator)
```

Expected result:
- synchronization fails with an integrity error;
- no journal or graph mutation is committed;
- the events are not poisoned or deduplicated.

### T10 — Same derived digest, different derivation

```
Host A contains sync event with:
  eventId = { kind: "sync", creator: syncAuthor, digest: "abc..." }
  derivation = { reason: "value-adoption", time: 100, ... }

Host B contains sync event with:
  eventId = { kind: "sync", creator: syncAuthor, digest: "abc..." }
  derivation = { reason: "value-adoption", time: 200, ... }
  (different time, so different derivation bytes)
```

Expected result:
- integrity violation — same digest but different derivation means the digest was forged or stored incorrectly;
- synchronization aborts without graph or journal mutation.

### T11 — Same derived effect produces identical digest

Given the same canonical graph effect and same cause IDs:
- Both merge directions (`canonicalMerge(A, B)` and `canonicalMerge(B, A)`) produce the same `SyncEventDerivation`.
- Both compute the same SHA-256 digest.
- Merging the converged result does not generate another notification because the derived event ID deduplicates against the already-existing entry.

### T12 — Sync-generated ordering without circularity

Two pending generated events whose ordinary payload comparison ties (same time, key, creator, action, identifier).

```
Event P: SyncEventDerivation { reason: "value-adoption", causes: [id1, id2], ... }
Event Q: SyncEventDerivation { reason: "deletion-adoption", causes: [id3], ... }
```

Ordered by provenance kind (existing < pending), then for pending by reason rank, then by causes array. After ordering and position assignment `P + 1`, `P + 2`, each receives:

```
eventId = { kind: "sync", creator: syncAuthor, digest: sha256(canonicalSerialize(derivation)) }
```
