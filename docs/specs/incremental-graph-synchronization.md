# Specification for Incremental Graph Synchronization

This document specifies synchronization of persisted IncrementalGraph replica
states. It constrains how materialized graph state may be merged across host
branches so that all future public IncrementalGraph operations remain valid
under "incremental-graph.md". It does not change the public `pull()` or
`invalidate()` semantics; it specifies only how stored graph state may be
checkpointed, staged, merged, invalidated, and committed during
synchronization.

---

## 1. Scope and Non-Goals

**Scope:**

- This specification covers synchronization of persisted IncrementalGraph
  state across host branches in a shared git repository.
- Synchronization is not a public computation operation. It is an
  administrative procedure that operates on stored replica state directly.
- Synchronization MUST NOT invoke computors. It may copy, delete, invalidate,
  or preserve stored graph state, but it must not compute new node values.
- Synchronization must preserve the public operational semantics of
  IncrementalGraph for all future calls to `pull()`, `invalidate()`, and the
  inspection API.
- Synchronization is allowed to be conservative: it may mark nodes
  "potentially-outdated" even when a stronger proof could have preserved them.
- Synchronization must not invent cache-validity facts that are not justified
  by source provenance and final graph structure.

**Non-goals:**

- This document does not specify git internals beyond the observable
  staging/checkpoint/branch role needed by synchronization.
- This document does not promise commutativity or order-independence across
  multiple host merges unless the implementation explicitly proves it.
- This document does not specify exact LevelDB key formats except where
  semantic lookup invariants require it.

---

## 1a. Division of Responsibility with Journal Synchronization

The journal synchronization specification
(`docs/specs/incremental-graph-journal-sync.md`) and this graph synchronization
specification have distinct responsibilities. This division must be preserved:

### Journal synchronization decides

- Canonical state journal event (which existing `add`, `edit`, or `delete` is
  the source of truth for the key).
- Canonical freshness-history event (which `validate` or `invalidate` is
  retained as journal history).
- Event identity integrity.
- Physical journal positions.
- Which existing events survive or are repositioned.
- Which journal event is used to notify callers of a synchronization result.

### Graph synchronization decides

- Whether the selected candidate value may remain cached.
- Whether it must become missing.
- Whether freshness may remain up to date.
- Whether it must become potentially outdated.
- Final validity metadata.
- Dependency relowering and provenance safety.

The canonical state event selects the candidate identifier/value provenance.
It does not override a graph-synchronization requirement to delete the candidate
cached value, make the node missing, or downgrade it to potentially outdated.
Synchronization still creates no logical journal event.

---

## 2. Replica State Model

**TERM-SYNC-01 (ReplicaState):** Persisted graph state for one schema version.
A replica contains node values, freshness markers, timestamps, validity
relations, an identifier lookup, allocation metadata, the graph scheme, and the
database version string.

**TERM-SYNC-02 (Local source replica L):** The active local replica before
merging a host. Read during per-host merge, never modified by it.

**TERM-SYNC-03 (Host source replica H):** Staged graph state scanned from one
remote hostname branch into hostname staging storage.

**TERM-SYNC-04 (Merge target replica T):** Inactive local replica used as the
write target during per-host merge. Initially a copy of L; after a successful
merge, contains the merged state and may become the active replica.

**TERM-SYNC-05 (Final replica F):** The state in T after a successful per-host
merge, before or after active-pointer switch.

**TERM-SYNC-06 (Semantic node key):** The stable semantic identity of a node
instance, derived from node name and bindings. Corresponds to `NodeKey` from
the main graph spec (DEF-KEY-01).

**TERM-SYNC-07 (Storage identifier):** Implementation-specific identifier used
as the actual database key for node values, freshness, timestamps, and validity
entries. Corresponds to `NodeIdentifier` from the volatile-consistency spec.

**TERM-SYNC-08 (Identifier lookup):** Bijective mapping between storage
identifiers and semantic node keys for materialized or known nodes. Persisted
as `identifiers_keys_map` in the replica's global sublevel.

**TERM-SYNC-09 (Materialized node):** A node whose storage identifier exists in
the identifier lookup (`identifiers_keys_map`). A materialized node may be
cached or missing.

**TERM-SYNC-09a (Cached node):** A materialized node with a stored value in the
`values` sublevel. A cached node's freshness is `"up-to-date"` or
`"potentially-outdated"`.

**TERM-SYNC-09b (Missing node):** A materialized node whose identifier exists in
the identifier lookup but has no stored value in `values`. Its freshness is
`"missing"`.

**TERM-SYNC-10 (Known node, deprecated):** A node present in the final
identifier lookup, whether or not it currently has a stored value. Use
"materialized node" (TERM-SYNC-09) instead; the two definitions are equivalent.

**TERM-SYNC-11 (Freshness):** Freshness state of a node: `"up-to-date"`,
`"potentially-outdated"`, or `"missing"`. The invariant is:
`freshness[id] === "missing"` iff `values[id]` is absent.

**TERM-SYNC-12 (Validity relation):** Inverse validity flags. The entry
`valid[D].has(N)` means N's stored value is known valid with respect to D's
current stored value, subject to the main IncrementalGraph validity rules.

**DEF-SYNC-01 (Value origin):** Provenance of a final stored value. An
internal proof object, not a public API concept:

- `{ kind: "source", side: "target" | "host", sourceId }` means the final
  stored value is known to have been copied or preserved from exactly that
  source side and source identifier.
- `{ kind: "none" }` means no such provenance proof is available. This includes
  absent values, deleted values, directly relowered values, and any value
  whose source cannot be proven.

**REQ-SYNC-01 (Value origin from copy, not equality):** Deep equality of
stored values MUST NOT create a value origin. Deep equality of stored values
MUST NOT upgrade `{ kind: "none" }` to `{ kind: "source", ... }`.

---

## 3. Synchronization Pipeline

**REQ-SYNC-02 (Normal synchronization):** Normal synchronization follows these
steps in order:

1. The caller holds the required synchronization/lock.
2. The live database is checkpointed into the tracked filesystem snapshot.
3. The local checkpoint branch is synchronized with the remote repository.
4. Remote hostname branches are fetched from the remote repository.
5. Each remote hostname branch is staged into hostname storage by scanning the
   branch's rendered snapshot.
6. Each staged host is merged into the local database by a per-host graph
   merge.
7. If a per-host merge switches the active replica, the root database is
   reopened before continuing to the next host.
8. Host staging storage is cleared after the per-host attempt (whether it
   succeeded or failed).
9. Failures are recorded per host. Synchronization may continue with remaining
   hosts and aggregate failures into a single error report.

**TERM-SYNC-13 (Reset-to-hostname mode):** A synchronization mode that is NOT
a graph merge. It synchronizes to a chosen hostname snapshot by replacing the
local state with the snapshot's state and returns without processing additional
hosts.

**REQ-SYNC-03 (Reset mode separation):** Reset-to-hostname mode must not be
mixed with normal per-host merge semantics. The reset procedure replaces
replica state wholesale; it does not merge.

---

## 4. Per-Host Merge Inputs and Preconditions

**TERM-SYNC-14 (Per-host merge inputs):** A per-host merge takes:

- **L**: active local source replica (read-only during merge).
- **H**: staged host source replica (read-only during merge).
- **T**: inactive local target replica (write target; initially a copy of L).

**Preconditions:**

1. The synchronization lock is held for the duration of the merge.
2. H was staged from exactly one hostname branch.
3. H and the local database have the same schema version. If not, the merge
   for that host MUST fail with a host-version mismatch error.
4. L is not modified by per-host merge.
5. T may be overwritten or refreshed during the merge.
6. H is staging storage and is cleared by the caller after the merge attempt.
7. The host and target identifier lookups must be parseable.
8. A storage identifier MUST NOT map to different semantic keys across source
   lookups. That is corrupt metadata and MUST be rejected with an
   `IdentifierLookupConflictError`.
9. The same semantic node may have different storage identifiers across
   replicas; that is not corrupt and must be reconciled by the merge plan.

**REQ-SYNC-04 (Materialized node coverage):** A materialized node must be
covered by its source identifier lookup. If a materialized value exists in
storage for a storage identifier not present in the identifier lookup, the
merge MUST reject the source as corrupt.

**REQ-SYNC-05 (Final coverage):** A final materialized node must be covered by
the final identifier lookup. Every storage identifier in the final values,
freshness, timestamps, and validity sublevels must appear in the final
identifier lookup.

**REQ-SYNC-06 (Malformed metadata rejection):** Synchronization must reject
malformed metadata (unparseable lookup, duplicate entries, index conflicts)
rather than silently dropping materialized values.

---

## 5. Semantic Merge Domain

**DEF-SYNC-02 (Semantic merge domain):** Per-host merge operates over semantic
node keys, not raw storage identifiers. Let:

- `Keys = keys(L.lookup) ∪ keys(H.lookup)`

Each key in Keys is considered exactly once. For each key, the merge chooses a
structural source side (target/local or host), selects a final storage
identifier, derives final dependency edges from the graph scheme, and applies
the result to T.

**DEF-SYNC-03 (Initial decision):**

- `initialDecision(key) ∈ { keep, take }`
- `keep` means the initial candidate is the local/target source.
- `take` means the initial candidate is the host source.

**DEF-SYNC-04 (Decision):**

- `decision(key) ∈ { keep, take, invalidate }`
- `keep` means preserve or copy from the local target source.
- `take` means copy from the host source.
- `invalidate` means the node is marked potentially-outdated regardless of
  which side provides its structural data.

**TERM-SYNC-15 (finalIdentifierForKey):** The map from each semantic node key
to its final storage identifier in the merged replica.

**TERM-SYNC-16 (mergedInputsMap):** The map from each final storage identifier
to the list of final dependency storage identifiers for that node, derived from
the graph scheme and lowered through `finalIdentifierForKey`.

---

## 6. Journal-Based State Selection

For journal-aware synchronization, the canonical state event selects the
candidate identifier and value provenance. The graph synchronization rules in
this document (value provenance, dependency relowering, conservative value
removal, validity proof transport, final freshness eligibility, and final-state
validation) remain authoritative for graph-level correctness. The journal
synchronization specification (`docs/specs/incremental-graph-journal-sync.md`)
specifies the exact algorithm for canonical state selection, canonical
freshness-history selection, event identity integrity, physical journal
positions, and notification positioning.

**REQ-SYNC-07 (Journal-based canonical state selection):** For each semantic
key, the canonical state event is selected by:

1. If only one source has a state entry in its logical journal view, that
   existing event is canonical.
2. If both sources have state entries, compare:
   * later journal-event `time`;
   * if times tie and identifiers differ, lexicographically greater
     `NodeIdentifier`;
   * if times and identifiers tie, lexicographically greater `eventId`.
3. If neither source has a state entry, the destination has none.

The canonical state event selects the identifier/value provenance. It does not
override a graph-synchronization requirement to delete the candidate cached
value, make the node missing, or downgrade it to potentially-outdated.

`modifiedAt` is preserved graph metadata:

- It is not rewritten by synchronization.
- It is not a journal-evidence fallback.
- It does not select the canonical state event.
- It must not introduce a local-source tie bias.

**REQ-SYNC-08 (State selection is not freshness):** The canonical state event
selects a candidate stored value and identifier. It does not by itself determine
final freshness. Freshness is governed by §9 (Freshness Merge Policy) and the
canonical freshness-history selection in the journal sync spec.

**REQ-SYNC-08a (modifiedAt preservation):** `modifiedAt` records the time at
which a node's stored semantic value last changed as a result of a computor
producing a changed value. When a value is preserved in the final state, its
existing `modifiedAt` is preserved unchanged. Synchronization MUST NOT
manufacture a new `modifiedAt` during merge. Every final `modifiedAt` must be
one of the timestamps already present in the merge inputs (L or H).

**REQ-SYNC-08b (No local-source tie bias):** The canonical state event
selection must not introduce a preference for the local source. The rules in
REQ-SYNC-07 apply symmetrically: swapping the two source roles produces the
same canonical event.

---

## 7. Conflict Propagation and Merge Decisions

**DEF-SYNC-05 (Force roots):**

- `forceKeepRoot`: a key where both replicas have the key and local
  `modifiedAt` is strictly newer.
- `forceTakeRoot`: a key where both replicas have the key and host `modifiedAt`
  is strictly newer.

**DEF-SYNC-06 (Taint propagation):**

- Keep-taint propagates forward from every `forceKeepRoot` along the initially
  chosen semantic dependency graph (the graph defined by
  `initialDecision`-selected source side and its graph scheme).
- Take-taint propagates forward from every `forceTakeRoot` along the initially
  chosen semantic dependency graph.

**DEF-SYNC-07 (Decision rules):**

- If a key is target-only:
  - `keep`, unless it is take-tainted, in which case `invalidate`.
- If a key is host-only:
  - `take`.
  - If it is keep-tainted, its final freshness must be `potentially-outdated`.
- If a key exists on both sides:
  - If both keep-tainted and take-tainted: `invalidate`.
  - Else if keep-tainted: `keep`.
  - Else if take-tainted: `take`.
  - Else: use `initialDecision`.

**Rationale:** A node downstream of conflicting timestamp choices cannot simply
inherit freshness from one side, because its stored value may have been
computed from inputs not chosen in the final graph. Invalidation is a
conservative way to preserve correctness without recomputing during sync.

---

## 8. Identifier Reconciliation and Edge Lowering

**REQ-SYNC-09 (Final identifier selection):** The final identifier for a
semantic key is selected from the chosen structural source side:

- `keep` → local source identifier.
- `take` → host source identifier.
- `invalidate` → identifier from `initialDecision`.

The final identifier lookup maps final storage identifiers to semantic keys.
It must be bijective.

**DEF-SYNC-08 (Direct relowering):** A final node is directly relowered when
the source-side dependency identifiers used by its stored value differ from the
final lowered dependency identifiers. This occurs when the node's structural
source side uses different storage identifiers for its inputs than the final
merged graph.

**REQ-SYNC-10 (Direct relowering rules):**

1. Directly relowered nodes MUST NOT remain `up-to-date`.
2. Directly relowered nodes MUST NOT preserve their stored value as a valid
   value for final freshness.
3. Directly relowered nodes SHOULD have their stored value deleted, because the
   system does not have a provenance proof that the stored value is valid for
   the final lowered inputs.
4. All materialized descendants of a directly relowered node MUST become
   `potentially-outdated` unless independently recomputed later outside
   synchronization (by `pull()`).
5. Synchronization MUST NOT invoke computors to repair directly relowered
   nodes.

---

## 9. Freshness Merge Policy

The canonical freshness-history event is selected by the journal
synchronization specification (Stage 5 in
`docs/specs/incremental-graph-journal-sync.md`). That selection determines
which `validate` or `invalidate` event is retained as journal history.

Final graph freshness is determined by the graph synchronization rules in this
section. The canonical freshness history event does not by itself force the
graph freshness — synchronization may conservatively produce
`potentially-outdated` or `missing` even when retained freshness history is
`validate`.

**REQ-SYNC-11 (Up-to-date eligibility):** A final node may be `up-to-date`
only if all of the following hold:

1. It is **cached** in the final state (has a stored value).
2. Every direct input (per the graph scheme) is known in the final identifier
   lookup.
3. Every direct input is cached (has a stored value).
4. Every direct input is itself `up-to-date`.
5. Every direct input has a validity flag for this node in the final validity
   relation.
6. The stored value's provenance and final dependency structure justify
   preserving it (the node was not invalidated by conflict propagation or
   relowering).
7. No applicable latest `invalidate` exists for the winning identifier.
   Either:
   * the canonical freshness history for the winning identifier is `validate`;
     or
   * there is no matching freshness history and the canonical state is `add`
     with initial up-to-date freshness.

If any of these do not hold, the node MUST be `potentially-outdated`,
`missing`, or nonmaterialized.

**REQ-SYNC-12 (Meaning of potentially-outdated):** `potentially-outdated` does
not mean the stored value is wrong. It means the system does not currently have
enough proof to return the stored value without recomputation. A
potentially-outdated node may still carry useful validity proofs about parts of
its dependency relation, subject to the validity proof transport rules of §11.

**REQ-SYNC-12a (Missing state after sync):** Synchronization may produce a
`missing` node — a materialized identifier with no cached value. This occurs
when the canonical state event selects a materialized identifier but the graph
synchronization rules require removal of the cached value (for example, after
direct relowering). The identifier remains materialized; a later `pull` may
recompute a value and emit `edit` + `validate`.

**REQ-SYNC-12b (A retained `validate` does not force up-to-date):** A retained
canonical `validate` event permits an up-to-date result (when all eligibility
conditions are satisfied) but does not force one. Synchronization may
conservatively produce `potentially-outdated` or `missing` even when the
retained freshness history is `validate`.

**REQ-SYNC-12c (A retained `invalidate` forbids up-to-date):** A retained
canonical `invalidate` event for the winning identifier forbids an up-to-date
result unless a later canonical `validate` exists. Synchronization must not
upgrade an invalidated node to `up-to-date` without a real later `validate`
event.

---

## 10. Value Origin and Provenance

**DEF-SYNC-09 (Final value origin rules):** For each final semantic key:

- Origin is `{ kind: "source", side: "target", sourceId }` only if:
  - the final stored value exists;
  - it was copied or preserved from the local source replica L;
  - `sourceId` is the local source identifier for the same semantic key;
  - the node is not directly relowered in a way that deletes or invalidates
    its value provenance.
- Origin is `{ kind: "source", side: "host", sourceId }` only if:
  - the final stored value exists;
  - it was copied or preserved from host source replica H;
  - `sourceId` is the host source identifier for the same semantic key;
  - the node is not directly relowered in a way that deletes or invalidates
    its value provenance.
- Origin is `{ kind: "none" }` otherwise.

**REQ-SYNC-13 (Equality does not create origin):**

- Equal stored values do not imply same origin.
- Equal stored values do not imply interchangeable validity proofs.
- Equal stored values do not permit importing source-side validity metadata.
- JSON or deep equality MUST NOT be used in value-origin inference.
- A value origin must be based on copy or preservation history, not on result
  comparison.

**Rationale:** The main IncrementalGraph spec permits nondeterministic
computors. Two computor invocations may produce equal values for different
reasons, under different hidden external conditions, or with different side
effects. Deep equality is a property of returned data, not a certificate that
the computation histories are interchangeable.

---

## 11. Validity Proof Transport

**DEF-SYNC-10 (Source validity proof):** A source-side relation entry
`valid[D].has(N)` means that, in that source replica, N's stored value was
known valid with respect to D's stored value according to the IncrementalGraph
validity algorithm.

**REQ-SYNC-14 (Validity proof transport conditions):** A source proof from
side `S ∈ { target, host }`:

```
valid[sourceD].has(sourceN)
```

may be transported to final:

```
valid[finalD].has(finalN)
```

only if ALL of the following hold:

1. `sourceD` and `sourceN` both have semantic keys in the source side's
   identifier lookup.
2. Those semantic keys both have final identifiers in
   `finalIdentifierForKey`.
3. `valueOrigin(finalD)` is exactly `{ kind: "source", side: S, sourceId:
   sourceD }`.
4. `valueOrigin(finalN)` is exactly `{ kind: "source", side: S, sourceId:
   sourceN }`.
5. `finalD` is a direct structural input of `finalN` in the final lowered
   graph per `mergedInputsMap`.
6. The final dependency edge is derived from the final graph scheme and
   semantic inputs, not copied blindly from source storage.

**REQ-SYNC-15 (Negative transport rules):**

- The source side must match for both endpoints. Cross-side mixed proofs MUST
  NOT be transported.
- Proofs involving deleted or discarded identifiers MUST NOT be transported.
- Proofs involving unknown semantic keys MUST NOT be transported.
- Proofs involving non-materialized final endpoints MUST NOT be transported.
- Proofs whose final edge is no longer a structural dependency MUST NOT be
  transported.
- Stored value equality MUST NOT be used as a fallback for any endpoint in
  validity proof transport. A proof is transported only on provenance match,
  not on extensional value match.

**REQ-SYNC-16 (Mandatory final validity flags):** After transporting safe
source proofs under the above rules, synchronization MUST add mandatory
validity flags for every final `up-to-date` materialized node and each of its
direct final inputs. This preserves the IncrementalGraph invariant that an
`up-to-date` node has direct validity flags for all inputs. This does not allow
making a stale node `up-to-date`; it only ensures the final validity relation
is complete for nodes that are already justified as `up-to-date`.

**REQ-SYNC-17 (Rebuild, not merge):** The final validity relation must be
rebuilt from the final lowered graph, not textually merged from source
validity relations. Transported proofs are added individually under the
conditions above; no bulk textual merge of validity storage is permitted.

---

## 12. Final-State Invariants

**REQ-SYNC-18 (Pre-switch validation):** After building the final merged state
in T but before switching the active replica pointer, the implementation MUST
validate the following invariants:

1. Every stored value key is present in the final identifier lookup.
2. Every freshness key is present in the final identifier lookup.
3. Every timestamp key is present in the final identifier lookup.
4. Every validity key is present in the final identifier lookup.
5. Every validity key is materialized (its identifier exists in the register).
6. Every validity dependent is present in the final identifier lookup.
7. Every validity dependent is materialized.
8. Every validity edge is a structural dependency edge in the final graph.
9. Every final `up-to-date` node is cached (has a stored value).
10. Every final `up-to-date` node's direct inputs are known in the final
    identifier lookup.
11. Every final `up-to-date` node's direct inputs are cached.
12. Every final `up-to-date` node's direct inputs are `up-to-date`.
13. Every final `up-to-date` node has validity flags from each direct input.
14. No discarded or losing storage identifier remains in values, freshness,
    timestamps, or validity storage.
15. The final identifier lookup is internally consistent and bijective.
16. The storage invariant holds: `freshness[id] === "missing"` iff
    `values[id]` is absent, for every materialized storage identifier.

**REQ-SYNC-19 (Validation failure):** If these invariants cannot be
established, the per-host merge MUST fail and the active replica pointer MUST
remain unchanged.

---

## 13. Commit and Active Replica Switching

**REQ-SYNC-20 (Write target isolation):** Per-host merge writes into inactive
replica T. The active replica pointer switches only after the final state is
built, validated, and committed.

**REQ-SYNC-21 (Switch condition):**

- If graph data, identifier mapping, freshness, or validity metadata changed,
  the inactive replica becomes active.
- If no semantic data, identifier data, freshness, or validity relation
  changed, the active pointer remains unchanged.
- A "metadata-only" change, such as importing a valid provenance-backed
  validity proof, is sufficient to switch replicas, because it affects future
  recomputation behavior. Metadata-only changes must obey the provenance rules
  of §11.

**REQ-SYNC-22 (Partial failure safety):** The currently active local source
replica must not be partially mutated by a failed host merge. Failure before
commit must not leave callers reading from an invalid partial merge target.

---

## 14. Multi-Host Synchronization

**REQ-SYNC-23 (Sequential per-host merge):** Normal synchronization may merge
multiple host branches sequentially. Each per-host merge observes the result of
prior successful per-host merges (because each merge may switch the active
replica and advance its state).

**REQ-SYNC-24 (Per-host validation after success):** The implementation MUST
validate the graph state after every successful per-host merge against the
invariants in §12 before proceeding to the next host.

**REQ-SYNC-25 (Host failure isolation):** If one host's merge fails,
synchronization may continue with remaining hosts and aggregate all failures
into a single composite error.

**REQ-SYNC-26 (No order independence guarantee):** This specification does not
guarantee host-order independence unless a future document proves and requires
it. Correctness is not CRDT-like convergence or commutative merge semantics.
The correctness obligation for multi-host synchronization is that each
individual per-host merge satisfies the invariants of §12 at the moment it
completes, and that the final state after all host merges (successful or
skipped) is a valid IncrementalGraph state from which all future public
operations produce results consistent with the main IncrementalGraph spec.
This is a safety property, not a convergence property.

---

## 15. Proof Obligations and Specification Labels

**TERM-SYNC-17 (Normative labels):** The following label prefixes are used
throughout this specification:

| Prefix | Category |
|--------|----------|
| TERM-SYNC- | Terminology definitions |
| DEF-SYNC- | Formal definitions |
| REQ-SYNC- | Normative requirements |
| PROP-SYNC- | Correctness properties |
| INV-SYNC- | Invariants |

**PROP-SYNC-01 (Public operation transparency):** After any sequence of
synchronization operations, the public IncrementalGraph operations
(`pull()`, `invalidate()`, inspection methods) produce results consistent with
the main IncrementalGraph specification given the same schema and the merged
state.

**PROP-SYNC-02 (Conservative freshness):** Synchronization never marks a node
`up-to-date` unless the rules in §9 and §11 are satisfied. It may mark nodes
`potentially-outdated` even when a more sophisticated proof might have
preserved them.

**PROP-SYNC-03 (No value invention):** Synchronization never introduces new
node values. Every final stored value originates from either the local source
replica L or the host source replica H, or was already present in the initial
copy of L into T.

**PROP-SYNC-04 (No computor invocation):** Synchronization never invokes a
computor function, directly or indirectly.
