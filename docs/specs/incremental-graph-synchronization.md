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
- Pairwise commutativity is required for any two valid source replicas using
  the same schema: merging A with B and merging B with A must produce
  observably equivalent final IncrementalGraph states after ignoring only
  local physical details such as inactive replica slot names and temporary
  paths.
- This document does not establish associativity across three or more replicas
  or arbitrary sequential host-order independence unless those properties are
  separately proven.
- This document does not specify exact LevelDB key formats except where
  semantic lookup invariants require it.

---

## 1a. Relationship to Journal Reconciliation

Graph synchronization is fully specified by this document and does not inspect
or depend on journal state. It produces the final merged graph and an abstract
notification delta (GraphDelta) consumed by journal reconciliation.

### GraphDelta

Define the public observable state of a semantic key `K`:

```
observableState(Graph, K) =
    unmaterialized

    or

    {
        materialized: true,
        value: cached ComputedValue,
        freshness: "up-to-date" | "potentially-outdated",
    }
```

Define equality:

```
equalObservableState(A, B) iff:
- both are unmaterialized; or
- both are materialized,
  isEqual(A.value, B.value),
  and A.freshness === B.freshness.
```

Internal details are excluded from observable state:

- `NodeIdentifier`
- `modifiedAt`
- allocation metadata
- validity proofs
- dependency metadata
- replica slot
- physical storage representation

Then define:

```
GraphDelta = { K | !equalObservableState(
    observableState(LGraph, K),
    observableState(FGraph, K)
) }
```

Graph synchronization must produce this exact set. Consequences:

- unmaterialized → materialized: included
- materialized → unmaterialized: included
- semantic value change: included
- freshness change: included
- identifier-only replacement with equal value and equal freshness: excluded
- metadata-only or validity-only change: excluded
- no observable change: excluded

Journal reconciliation receives GraphDelta and must not inspect or compare
`ComputedValue`s itself.

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
identifiers and semantic node keys for materialized nodes. Persisted
as `identifiers_keys_map` in the replica's global sublevel.

**TERM-SYNC-09 (Materialized node):** A node whose identifier exists in
`identifiers_keys_map`, `values`, `freshness`, and `timestamps`.

**TERM-SYNC-11 (Freshness):** Freshness state of a node: `"up-to-date"` or
`"potentially-outdated"`.

**TERM-SYNC-12 (Validity relation):** Inverse validity flags. The entry
`valid[D].has(N)` means N's stored value is known valid with respect to D's
current stored value, subject to the main IncrementalGraph validity rules.

**DEF-SYNC-01 (Value origin):** Provenance of a final stored value. A
conceptual term, not a separate runtime representation:

- The selected byte source identifies which replica supplied the final stored
  bytes. Every surviving value (outcome ≠ delete) has provenance from its
  selected structural side, including hard-invalidated and directly relowered
  nodes. Deleted nodes have no final value and therefore no value origin.
- The runtime representation of byte-source selection is `selectedSideByKey`.
  No separate value-origin map is maintained.

**DEF-SYNC-02 (Source-version identity):** A source-side materialization
represents the final selected semantic value record only when it is the actual
selected source materialization: its side matches `selectedSideByKey` and its
identifier matches the final selected identifier.

This is the canonical `sourceRepresentsFinalVersion()` operation. It
determines whether source-side dependency histories and validity proofs apply
to the final selected semantic record. Equal timestamps and equal identifiers do
not prove equal values because a recomputation preserves the identifier and
`modifiedAt` has finite resolution. ComputedValue equality, hashing, or
serialization must not be used as identity evidence.

**REQ-SYNC-01 (Value origin from copy, not equality):** Deep equality of
stored values MUST NOT create a value origin.

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

**DEF-SYNC-03 (Semantic merge domain):** Per-host merge operates over semantic
node keys, not raw storage identifiers. Let:

- `Keys = keys(L.lookup) ∪ keys(H.lookup)`

Each key in Keys is considered exactly once. For each key, the merge chooses a
structural source side (target/local or host), selects a final storage
identifier, derives final dependency edges from the graph scheme, and applies
the result to T.

**DEF-SYNC-04 (Selected source side):** `selectedSideByKey` records the
per-node candidate source side before final outcome classification:

- `selectedSideByKey(key) ∈ { keep, take }`
- `keep` means the candidate source is the local/target replica.
- `take` means the candidate source is the host replica.

**DEF-SYNC-05 (Final outcome):** `outcomeByKey` records the canonical final
outcome for each semantic key after classification:

- `outcomeByKey(key) ∈ { keep, take, invalidate, delete }`
- `keep` means preserve or copy from the local target source.
- `take` means copy from the host source.
- `invalidate` means the node is marked potentially-outdated regardless of
  which side provides its structural data. One-input direct invalidation roots
  are invalidated; their value is retained.
- `delete` means the semantic key's materialization is omitted from the final
  replica. A deleted materialization has no final identifier, cached value,
  freshness, timestamps, validity entries, or value origin. Multi-input direct
  invalidation roots are deleted. `delete` is an internal merge result, not a
  request to delete the semantic node family from the graph schema.

**TERM-SYNC-15 (finalIdentifierForKey):** A partial map from semantic node keys
to their final storage identifiers:

```
finalIdentifierForKey:
    { key ∈ Keys | outcomeByKey(key) ≠ delete } → NodeIdentifier
```

- `keep` maps to the local source identifier.
- `take` maps to the host source identifier.
- `invalidate` maps to the identifier selected by `selectedSideByKey`.
- `delete` has no final identifier and is absent from the map.

**TERM-SYNC-16 (mergedInputsMap):** The map from each surviving final storage
identifier to the list of its final dependency storage identifiers, derived from
the graph scheme and lowered through `finalIdentifierForKey`. Defined only for
materializations whose outcome is not `delete`. Every dependency of a surviving
materialization also survives and has a final identifier; the delete-propagation
closure guarantees this.

---

## 6. Timestamp Conflict Policy

**REQ-SYNC-07 (Canonical materialization selection):** For each semantic key:

- If present only in L: select that materialization.
- If present only in H: select that materialization.
- If present in both L and H, compare materialization candidates by the fixed
  tuple `(modifiedAt, NodeIdentifier, sourceFingerprint)`:
  1. the newer `modifiedAt` wins;
  2. on equal `modifiedAt`, the lexicographically greater canonical
     `NodeIdentifier` string wins using deterministic JavaScript code-unit
     ordering;
  3. on equal `modifiedAt` and `NodeIdentifier`, the lexicographically greater
     validated source replica fingerprint wins using deterministic JavaScript
     code-unit ordering.
- The comparison MUST NOT prefer a candidate because it is named local, host,
  keep, take, current, or target.
- Missing timestamps for materialized values are invalid or corrupt state under
  the main graph spec. Synchronization MUST NOT use missing timestamps to
  justify an `up-to-date` final node. It may reject the host or merge
  conservatively invalidate affected nodes, but it must not silently create an
  `up-to-date` value whose timestamp provenance is broken.

**REQ-SYNC-08 (Timestamps are not freshness proofs):** Timestamps select
candidate stored values. They do not by themselves prove that a value is
correct with respect to final merged inputs. Timestamp order is not a semantic
proof of freshness.

**REQ-SYNC-08d (Selected record timestamp copy):** Candidate selection chooses
one complete stored materialization record. The final value, `createdAt`, and
`modifiedAt` are copied from that selected record. Synchronization never
combines the value from one source with timestamps from another source, never
uses merge execution time as a materialization timestamp, and never computes a
minimum or maximum `createdAt` across sources.

**REQ-SYNC-08a (modifiedAt is a value version, not a merge timestamp):**
`modifiedAt` records the time at which a node's stored semantic value last
changed as a result of a computor producing a changed value. Merge decisions
and metadata transformations produce no new semantic versions.

- Taking a value copies its exact existing `modifiedAt` from the host side.
- Keeping a value preserves its exact existing `modifiedAt`.
- Invalidating freshness or rebuilding validity does not change `modifiedAt`.
- Identifier reconciliation, input-edge relowering, and freshness changes do
  not change `modifiedAt`.
- Synchronization MUST NOT manufacture a new `modifiedAt` during merge.
  Every final `modifiedAt` must be one of the timestamps already present in
  the merge inputs (L or H).
- Consequently, merging two fixed database snapshots is independent of
  merge execution time. The result would be identical if the merge ran at
  any future or past time.

**REQ-SYNC-08b (No mergedAt field):** Synchronization MUST NOT introduce a
persistent `mergedAt` field. Sync timing is available through logs and Git
commits.

**REQ-SYNC-08c (Same-coordinate stale freshness):** When both replicas have
identical `modifiedAt` and identical `NodeIdentifier` for a semantic key, the
records share a materialization coordinate but not necessarily a value. The
merge MUST be conservative for freshness only:

* If the selected side's value is `up-to-date` and the non-selected side's
  freshness is not `up-to-date`, the final node MUST NOT remain `up-to-date`.
  Set it to `potentially-outdated` without changing `modifiedAt` or the selected
  value.
* If the selected side is already not `up-to-date`, no adjustment is needed.
* This same-coordinate relation MUST NOT create value provenance, dependency
  history, or validity-proof transport for the non-selected source.
* The stale metadata belonging to an older value version (`modifiedAt`)
  MUST NOT taint a strictly newer value version. If one side has a newer
  `modifiedAt`, the value selection based on timestamps is authoritative
  and the stale metadata from the older version does not affect the
  newer version's freshness.

---

## 7. Candidate Selection, Direct Invalidation, and Deletion

The temporary pairwise merge rule implemented for
https://github.com/ottojung/volodyslav/issues/1520 separates source selection,
direct hard invalidation, propagated staleness, and deletion. The future
journal-backed coherent-history rule is tracked by
https://github.com/ottojung/volodyslav/issues/1521; this section specifies only
the current conservative pairwise behaviour.

**DEF-SYNC-06 (Taint propagation):** Keep-taint propagates forward from every
key where the local candidate strictly wins by the complete canonical tuple.
Take-taint propagates forward from every key where the host candidate strictly
wins by the complete canonical tuple. Taint is ancestry information, not a
source-selection override. A selected local/target candidate has opposite-side
ancestry when take-taint reaches it. A selected host candidate has opposite-side
ancestry when keep-taint reaches it.

**DEF-SYNC-07 (Direct invalidation candidate):** A direct invalidation candidate
is a selected cached node whose next required recomputation must invoke the
computor rather than accept cache-only revalidation. Candidates are produced by:

1. opposite-side ancestry reaching the selected candidate;
2. direct input relowering;
3. same-coordinate stale freshness metadata from REQ-SYNC-08c.

**DEF-SYNC-08 (Direct relowering):** A selected cached node is directly
relowered when at least one distinct semantic direct input used by its source
materialization does not represent the final selected version of that semantic
input through the canonical source-version identity relation
(DEF-SYNC-02). Different storage identifiers, equal timestamps, or equal stored
values do not make a non-selected source represent the selected source. Direct
relowering creates a direct invalidation candidate; it is not by itself a
deletion decision.

**REQ-SYNC-09 (Distinct semantic input classifier):** The classifier counts
distinct semantic direct dependency keys. It must not count computor argument
positions, graph-scheme arity, lowered storage identifiers, or validity-edge
count. `X(A)` and `X(A, A)` have one distinct semantic input. `X(A, B)` has two
distinct semantic inputs.

For every direct invalidation candidate:

- zero or one distinct semantic input: retain the selected cached value,
  preserve its `modifiedAt`, mark it `potentially-outdated`, and remove incoming
  validity proofs so the next pull invokes the computor with the retained value
  as `oldValue`;
- more than one distinct semantic input: delete the materialization so the next
  pull invokes the computor with `oldValue === undefined`, and `Unchanged` is not
  legal.

Direct relowering therefore follows:

```text
direct relowering
    → direct invalidation candidate
    → hard invalidate when distinct-input count <= 1
    → delete when distinct-input count > 1
```

Thus `A → B` may hard-invalidate `B` when synchronization ambiguity prevents
`B` from remaining current, but it does not delete `B`. For `A,B → D`, once `D`
requires direct hard invalidation, the temporary policy deletes `D`.

**REQ-SYNC-10 (Structural deletion closure):** Deletion roots expand through
transitive materialized dependents in the selected semantic dependency graph. If
`D` is deleted in `A,B → D → E → F`, then `E` and `F` are deleted as
materialized dependents, while `A`, `B`, siblings, and unrelated
materializations such as `U` survive. The closure follows structural semantic
dependencies, not only validity edges, and synchronization never invokes
computors while applying it. Deleted nodes have no final identifier, cached
value, freshness, timestamps, validity entries, or value origin.

**TERM-SYNC-17 (Propagated staleness):** A node can become
`potentially-outdated` because one of its inputs is stale. That is propagated
staleness, not a direct invalidation candidate. Propagated stale nodes retain
transportable incoming proofs and are not deleted merely because they have
multiple inputs.

---

## 8. Identifier Reconciliation and Edge Lowering

**REQ-SYNC-11 (Final identifier selection):** For each semantic key whose
outcome is not `delete`, the final identifier is selected from
`selectedSideByKey`:

- `keep` → local source identifier.
- `take` → host source identifier.
- `invalidate` → the source identifier selected by `selectedSideByKey`.

The final identifier lookup maps final storage identifiers to semantic keys for
surviving materializations only. It must be bijective between final identifiers
and `FinalKeys = { key ∈ Keys | outcome(key) ≠ delete }`. Deleted keys must
not remain in the lookup.

---

## 9. Freshness Merge Policy

**REQ-SYNC-11a (Up-to-date eligibility):** A final node may be `up-to-date`
only if all of the following hold:

1. It has a stored value in the final state.
2. Every direct input (per the graph scheme) is known in the final identifier
   lookup.
3. Every direct input is materialized (has a stored value).
4. Every direct input is itself `up-to-date`.
5. Every direct input has a validity flag for this node in the final validity
   relation.
6. The stored value's provenance and final dependency structure justify
   preserving it (the node was not invalidated by conflict propagation or
   relowering).

If any of these do not hold, the node MUST be `potentially-outdated` or
unmaterialized.

**REQ-SYNC-12 (Meaning of potentially-outdated):** `potentially-outdated` means
the system does not currently have enough proof to guarantee the stored value
without verifying it. A stale node pulls all dependencies:

- A **direct invalidation root** has had all incoming proofs removed. Its next pull must invoke its computor.
- A **propagated stale descendant** retains all incoming and outgoing proofs. Its next pull may cache-revalidate without invoking its computor when every incoming proof remains present.

A stale node that cache-revalidates is marked `up-to-date` and returns its stored value. A stale node whose cache predicate fails invokes its computor.

---

## 10. Value Origin and Provenance

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

**DEF-SYNC-09 (Source validity proof):** A source-side relation entry
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
3. `sourceD` represents the final version of D through the canonical
   source-version identity relation (DEF-SYNC-02).
4. `sourceN` represents the final version of N through the same relation.
5. `finalD` is a direct structural input of `finalN` in the final lowered
   graph per `mergedInputsMap`.
6. The final dependency edge is derived from the final graph scheme and
   semantic inputs, not copied blindly from source storage.

The two endpoints of the source proof must still come from one source replica.
Their final stored byte origins do not need to be that source replica when
equal-timestamp copies represent the same temporary semantic versions.

**REQ-SYNC-15 (Negative transport rules):**

- The source side must match for both endpoints. Cross-side mixed proofs MUST
  NOT be transported.
- Proofs involving deleted or discarded identifiers MUST NOT be transported.
- Proofs involving unknown semantic keys MUST NOT be transported.
- Proofs involving non-materialized final endpoints MUST NOT be transported.
- Proofs whose final edge is no longer a structural dependency MUST NOT be
  transported.
- Stored value equality MUST NOT be used as a fallback for any endpoint in
  validity proof transport. A proof is transported only when both endpoints
  represent the final selected versions through the canonical identity
  relation, not on extensional value match.

**REQ-SYNC-16 (Required incoming validity for up-to-date nodes):** Every final
`up-to-date` materialized node must have complete incoming validity proofs for
all its direct inputs. Validated source invariants plus source-version identity
(DEF-SYNC-02) justify complete proof transport for every node that is not a
direct invalidation candidate. Validity reconstruction expects the planning
classification to be complete and throws `UnplannedMissingValidityProofError` if
a missing proof is discovered. Reconstruction does not itself create a new direct
invalidation root.

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
5. Every validity key is materialized.
6. Every validity dependent is present in the final identifier lookup.
7. Every validity dependent is materialized.
8. Every validity edge is a structural dependency edge in the final graph.
9. Every final `up-to-date` node has a stored value.
10. Every final `up-to-date` node's direct inputs are known in the final
    identifier lookup.
11. Every final `up-to-date` node's direct inputs are materialized.
12. Every final `up-to-date` node's direct inputs are `up-to-date`.
13. Every final `up-to-date` node has validity flags from each direct input.
14. No discarded or losing storage identifier remains in values, freshness,
    timestamps, or validity storage.
15. The final identifier lookup is internally consistent and bijective.

**REQ-SYNC-19 (Validation failure):** If these invariants cannot be
established, the per-host merge MUST fail and the active replica pointer MUST
remain unchanged.

---

## 13. Commit and Active Replica Switching

**REQ-SYNC-20 (Write target isolation):** Per-host merge writes into inactive
replica T. The active replica pointer switches only after the final state is
built, validated, and committed.

**TERM-SYNC-18 (Merge summary):** After each per-host merge, the implementation
records counts of outcomes:

- `kept`: number of semantic keys whose final outcome is `keep`.
- `taken`: number of semantic keys whose final outcome is `take`.
- `invalidated`: number of semantic keys whose final outcome is `invalidate`.
- `deleted`: number of semantic keys whose final outcome is `delete`.

A deletion counts as a semantic graph-state change only when the target replica
previously contained that materialization. A host-only key that is deleted
before ever being written to the target does not by itself change the target
state.

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

**REQ-SYNC-23 (Pairwise commutativity):** For valid source replicas A and B using the same schema, merging A with B and merging B with A produce observably equivalent final IncrementalGraph states. Observable equivalence includes semantic keys, selected identifiers, stored values, freshness, timestamps, lowered inputs, reverse dependencies, validity proofs, deletion outcomes, and invalidation outcomes. It excludes host-local allocator capability metadata: each host intentionally retains its own `fingerprint` and `last_node_index` allocation namespace. It may also ignore local physical details such as temporary paths, logs, replica-slot names, and source-role labels.

**REQ-SYNC-24 (Sequential per-host merge):** Normal synchronization may merge
multiple host branches sequentially. Each per-host merge observes the result of
prior successful per-host merges (because each merge may switch the active
replica and advance its state).

**REQ-SYNC-25 (Per-host validation after success):** The implementation MUST
validate the graph state after every successful per-host merge against the
invariants in §12 before proceeding to the next host.

**REQ-SYNC-26 (Host failure isolation):** If one host's merge fails,
synchronization may continue with remaining hosts and aggregate all failures
into a single composite error.

**REQ-SYNC-27 (No multi-host order independence guarantee):** This specification requires pairwise commutativity for a single two-replica merge. It does not guarantee associativity across three or more replicas or arbitrary sequential host-order independence unless a future document proves and requires those properties. Correctness is not full CRDT-like convergence.
The correctness obligation for multi-host synchronization is that each
individual per-host merge satisfies the invariants of §12 at the moment it
completes, and that the final state after all host merges (successful or
skipped) is a valid IncrementalGraph state from which all future public
operations produce results consistent with the main IncrementalGraph spec.
This is a safety property, not a convergence property.

---

## 15. Proof Obligations and Specification Labels

**TERM-SYNC-19 (Normative labels):** The following label prefixes are used
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
