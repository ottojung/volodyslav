# Specification for Incremental Graph Synchronization

This document specifies synchronization of persisted IncrementalGraph replica
states. It constrains how materialized graph state may be merged across hosts
so that all future public IncrementalGraph operations remain valid under
"incremental-graph.md". It does not change the public `pull()` or
`invalidate()` semantics; it specifies only how stored graph state may be
exported, staged, merged, invalidated, and committed during synchronization.

---

## 1. Scope and Non-Goals

**Scope:**

- This specification covers synchronization of persisted IncrementalGraph
  state across hosts. It is transport-neutral: it never depends on how logical
  snapshots are stored or exchanged (see `incremental-graph-journal-types.md`
  § Transport boundary).
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

- This document does not specify the transport used to obtain or store logical
  snapshots; that is the responsibility of an external transport adapter.
- Pairwise commutativity is required for any two valid source replicas using
  the same schema: merging A with B and merging B with A must produce
  observably equivalent final IncrementalGraph states after ignoring only
  local physical details such as inactive replica slot names and temporary
  paths.
- The merge is a canonical logical join: it is commutative, associative, and
  idempotent, so the result for any set of snapshots is independent of the
  grouping or order in which they are merged (see § 1b Logical join).
- This document does not specify the transport used to obtain or store logical
  snapshots; that is the responsibility of an external transport adapter.
- This document does not specify exact LevelDB key formats except where
  semantic lookup invariants require it.

---

## 1a. Relationship to Journal Reconciliation

Graph synchronization is fully specified by this document and does not inspect
or depend on journal state. It produces the final merged graph and defines the
observable-state abstraction used by journal reconciliation.

"Journal state" here means journal entries, journal absences, and
`last_journal_index`. Graph synchronization does read one piece of provenance
metadata — the `SourceSnapshotProvenance.causalFrontier` — but only as the
per-host merge gate of REQ-SYNC-02a (skip a staged logical snapshot whose
complete frontier is already dominated by the local frontier; reject a
regressed, conflicting, or unresolvable coordinate). It never inspects journal
entries to plan the graph merge.

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

Journal reconciliation does not consume the directional `GraphDelta` directly.
It requires the symmetric journal synchronization delta `SyncDelta` defined in
`docs/specs/incremental-graph-journal-sync.md`:

```
SyncDelta = {
    K |
    !equalObservableState(A(K), F(K))
    ||
    !equalObservableState(B(K), F(K))
}
```

where `A` and `B` are the two exact source snapshots and `F` is the
deterministic commutative merge result. A key is in `SyncDelta` whenever
installing `F` changes its public observable state relative to either source.
Journal reconciliation must not inspect or compare `ComputedValue`s itself.

Each synchronized logical snapshot and merged destination carries a
`SourceSnapshotProvenance` — a `LogicalSnapshotId`, a causal frontier, the merge
protocol version, and the schema version (see
`incremental-graph-journal-types.md` § Logical snapshot identity) — which
journal reconciliation uses to derive sync event identity and contributor sets.
Pairwise merge rejects inputs with mismatching merge protocol or schema
versions, and the frontier union rejects inputs whose frontiers record
unresolvable coordinates for a common hostname (for example, a regression within
a storage instance, or a different `HostInstanceId` for the same hostname, an
administrative conflict). The merged destination's provenance is durably
established before the destination becomes active or is used as the source of a
later per-host merge.

---

## 1b. Logical Join

The complete graph-and-journal merge is a canonical logical join over the
represented host-originated logical contributions. It is:

```text
commutative:
merge(A, B) = merge(B, A)

associative:
merge(merge(A, B), C) = merge(A, merge(B, C))

idempotent:
merge(A, A) = A
```

Equality covers synchronization-relevant logical state:

- graph materializations and selected values;
- freshness;
- identifiers where logically relevant;
- dependency and validity state;
- deletion and invalidation outcomes;
- canonical journal state;
- causal frontier;
- the persisted merge basis;
- deterministic `LogicalSnapshotId`.

**Logical-join invariant:** For valid snapshots, the logical merge result is
determined by the represented host-originated logical states, not by the
grouping or order in which those states were previously merged.

The join is executable from persisted state: it is defined over the **merge
basis** (§ 1c), not over the original input replicas. Every per-key decision —
candidate selection (§6), direct invalidation, multi-input deletion, deletion
closure (§7), validity reconstruction (§11), journal event selection, and
carrier placement — is a deterministic function of the joined merge basis, and
is therefore independent of grouping. Physical storage may differ between two
replicas with equal logical merge state: compaction and local layout are not
part of the join result.

The causal frontier may serve as the complete no-op gate only because the merge
basis is closed under merge and persisted: when the local frontier dominates a
staged frontier, the staged snapshot contributes no host-originated logical
state that is not already represented in the local basis, so the join is
unchanged.

---

## 1c. Merge Basis

A derived replica must be able to perform a later associative join without the
original input replicas. It therefore persists a compact, per-key **merge
basis** that is closed under merge. Exported snapshots include the merge basis
or a canonical equivalent. The causal frontier summarizes which host
contributions are included, but it does not substitute for the merge basis.

### CandidateId

`CandidateId` is the globally unambiguous, reproducible identity of one
host-originated candidate for one semantic key. It is a fixed-size digest,
never an implementation-selected UUID or unspecified string:

```text
CandidateId = sha256(encode([
    "candidate-v1",
    hostnameToString(hostname),
    hostInstanceIdToString(instanceId),
    hostStateVersionToNumber(version),
    nodeKeyToString(semanticKey),
]))
```

where `(hostname, instanceId, version)` is the origin coordinate of the
originating host contribution. It is reproducible from the originating host
contribution alone (the origin coordinate and the semantic key), and it is
immutable. Because a host's version advances once per durable transaction, one
transaction authors at most one candidate per semantic key.

### Candidate types

```js
/**
 * The tuple that deterministically orders candidate state.
 *
 * @typedef {object} CandidateComparisonKey
 * @property {UnixTimestamp} modifiedAt
 * @property {NodeIdentifier} nodeIdentifier
 * @property {string} sourceFingerprint
 */
```

Candidates (materialized and tombstone) are totally ordered by the canonical
comparison tuple: newer `modifiedAt` wins; on tie, the lexicographically
greater canonical `NodeIdentifier`; on tie, the lexicographically greater
`sourceFingerprint`.

```js
/**
 * A reference to the exact input candidate a value was computed against.
 *
 * @typedef {object} InputCandidateReference
 * @property {NodeKey} semanticKey
 * @property {CandidateId} candidateId
 */
```

```js
/**
 * One host-originated materialization of a semantic key.
 *
 * @typedef {object} MaterializedCandidate
 * @property {CandidateId} candidateId
 * @property {{ hostname: Hostname, instanceId: HostInstanceId, version: HostStateVersion }} origin
 * @property {NodeKey} semanticKey
 * @property {"materialized"} kind
 * @property {ComputedValue} value
 * @property {{ createdAt: UnixTimestamp, modifiedAt: UnixTimestamp }} timestamps
 * @property {NodeIdentifier} identifier
 * @property {ReadonlyArray<InputCandidateReference>} inputCandidateIds
 *   - The exact selected input candidate IDs against which this value is valid.
 * @property {"up-to-date" | "potentially-outdated"} freshness
 * @property {CandidateComparisonKey} comparisonKey
 */
```

```js
/**
 * One host-originated deletion tombstone of a semantic key.
 *
 * A deletion is represented by an ordered tombstone candidate, never by missing
 * storage alone.
 *
 * @typedef {object} TombstoneCandidate
 * @property {CandidateId} candidateId
 * @property {{ hostname: Hostname, instanceId: HostInstanceId, version: HostStateVersion }} origin
 * @property {NodeKey} semanticKey
 * @property {"tombstone"} kind
 * @property {UnixTimestamp} deletionTime
 * @property {CandidateComparisonKey} comparisonKey
 */
```

A tombstone's `comparisonKey` uses `modifiedAt = deletionTime`, a canonical
deletion `NodeIdentifier` derived from the origin, and the origin's
`sourceFingerprint`. A tombstone with a later `deletionTime` supersedes an
earlier materialized candidate; a materialized candidate with a later
`modifiedAt` supersedes an earlier tombstone.

```js
/**
 * @typedef {MaterializedCandidate | TombstoneCandidate} Candidate
 */
```

### Canonical serialization and equality

Every type in this section has a canonical byte encoding: the record's fields
are sorted by a fixed field order, each field is encoded by its canonical
form, and the resulting byte sequence is the type's canonical serialization.
Record equality is byte equality of the canonical serialization. A record is
authored exactly once at its construction site (its origin transaction) and is
immutable thereafter; a join never mutates a record, it unions deduplicated
copies. This is what lets the canonical serialization participate in
`LogicalSnapshotId` hashing and in the integrity comparison of transported
merge bases.

### Evidence types

```js
/**
 * A monotonic freshness fact about a semantic key.
 *
 * @typedef {object} FreshnessFact
 * @property {{ hostname: Hostname, instanceId: HostInstanceId, version: HostStateVersion }} origin
 * @property {"up-to-date" | "potentially-outdated"} tone
 * @property {UnixTimestamp} time
 */
```

`FreshnessEvidence(key)` is a set of `FreshnessFact`s. Its join is set union:
`joinFreshnessEvidence(E1, E2) = E1 ∪ E2`, which is commutative, associative,
and idempotent by construction (sets are unordered and deduplicated). The
projected freshness is `potentially-outdated` if any fact is
`potentially-outdated` or any direct input is projected stale; otherwise
`up-to-date` (conservative monotonic combination).

```js
/**
 * Validity evidence of one materialized candidate: the transported proofs are
 * the input candidate references themselves. A value is valid only against
 * the exact input candidate IDs it records.
 *
 * @typedef {ReadonlyArray<InputCandidateReference>} ValidityEvidence
 */
```

`joinValidityEvidence` unions two evidence sets and is commutative,
associative, and idempotent by construction. Validity transport is performed
only when the candidate's recorded input candidate IDs equal the final selected
input candidate IDs.

```js
/**
 * Conflict evidence for a semantic key: the candidate comparison facts that
 * could still affect a future join.
 *
 * @typedef {object} ConflictEvidence
 * @property {ReadonlyArray<Candidate>} candidates
 * @property {ReadonlyArray<FreshnessFact>} stalenessFacts
 */
```

`joinConflictEvidence(C1, C2)` is the union of the two candidate sets and the
two staleness-fact sets, pruned by the dominance rule below. It is
commutative, associative, and idempotent by construction.

### Semilattice operations

```text
joinCandidateSets(S1, S2)      = the union of the two candidate sets, pruned by
                                 candidate dominance

joinFreshnessEvidence(E1, E2)  = E1 ∪ E2

joinValidityEvidence(V1, V2)   = V1 ∪ V2

joinConflictEvidence(C1, C2)   = (candidates(S1 ∪ S2) pruned,
                                  stalenessFacts(E1 ∪ E2))

joinMergeBasis(A, B)           = per-key:
                                   candidates  = joinCandidateSets
                                   freshness   = joinFreshnessEvidence
                                   validity    = joinValidityEvidence
                                   conflicts   = joinConflictEvidence
```

Each operation is the union of an unordered, deduplicated set and is therefore
commutative, associative, and idempotent by construction — not merely by
declaration.

### Candidate dominance and safe pruning

A candidate `c1` is **dominated** by a retained candidate `c2` for the same
semantic key when `c2.comparisonKey > c1.comparisonKey` (the total comparison
tuple) and `c1` is not referenced as an input by any retained materialized
candidate and `c2`'s evidence absorbs `c1`'s evidence.

Safe pruning: a candidate that is dominated by a retained candidate, is not
referenced as an input, and whose freshness/validity evidence is absorbed by
retained evidence may be removed. A candidate that could still win a future
selection (its comparison key is not exceeded by a retained candidate), that is
referenced as an input by a retained materialized candidate, or whose evidence
has not been absorbed MUST be retained. Information needed by later merges must
never be silently discarded.

### projectGraph

`projectGraph(joinedMergeBasis)` is the deterministic projection to the
installed graph state, computed in this order:

1. **Determine the winning candidate or tombstone for every semantic key**:
   take the maximum by `CandidateComparisonKey` among the key's retained
   candidates (a tombstone may win, superseding all materialized candidates).
2. **Identify the selected input candidate IDs**: the winning
   materialized candidate's `inputCandidateIds`.
3. **Determine whether the selected value was computed against the final
   selected inputs**: for every direct input, compare the recorded input
   candidate ID against the final selected candidate ID for that input.
4. **Determine direct invalidation**: a key is a direct invalidation candidate
   when its winning value was not computed against the final selected inputs
   (direct input relowering), or a same-coordinate stale freshness fact
   applies. This replaces the pairwise source-fidelity notion with an exact
   candidate-input comparison.
5. **Apply the zero/one-input versus multi-input policy**: a direct
   invalidation candidate with zero or one distinct semantic inputs is retained
   and hard-invalidated (value kept, freshness `potentially-outdated`, incoming
   proofs removed); with more than one distinct input it is deleted (its winner
   is replaced by a derived tombstone).
6. **Apply deletion closure**: any materialized key with a deleted direct input
   is deleted transitively.
7. **Derive final freshness**: a surviving materialization is `up-to-date` only
   if it is not a direct invalidation candidate, every direct input is
   materialized and `up-to-date`, and the freshness evidence contains no stale
   fact for it; otherwise `potentially-outdated`.
8. **Reconstruct validity**: a surviving `up-to-date` materialization receives
   incoming validity edges from each final direct input whose candidate ID
   matches the value's recorded input candidate ID.
9. **Assign final identifiers and dependency edges**: the surviving
   materializations form the final identifier lookup and lowered dependency
   edges.

Candidate selection, direct invalidation, dependency relowering, deletion
closure, freshness, and validity reconstruction are all computable from the
joined merge basis; the merge basis is the single algorithm, and there is no
separate pairwise implementation.

### Tombstone semantics

- A tombstone is created by any host-originated deletion: a host-local graph
  deletion, a migration `storage.delete`, or a bulk reset deletion. Its
  `deletionTime` is the deletion transaction's time and its origin is the
  deleting host's contribution coordinate.
- Synchronization-derived deletion does not create a new tombstone per merge
  grouping: it projects deletion from the retained evidence by selecting the
  tombstone candidate that wins `projectGraph` step 1 and applying steps 5-6.
  A tombstone introduced by any host is retained and deduplicated by
  `CandidateId`.
- A later materialization supersedes a tombstone when the materialized
  candidate's comparison key exceeds the tombstone's (a later `modifiedAt` on a
  value beats an earlier `deletionTime`), and vice versa.
- Older candidates and tombstones may be discarded only by the safe-pruning
  rule above.

---

## 2. Replica State Model

**TERM-SYNC-01 (ReplicaState):** Persisted graph state for one schema version.
A replica contains node values, freshness markers, timestamps, validity
relations, an identifier lookup, allocation metadata, the graph scheme, and the
database version string.

**TERM-SYNC-02 (Local source replica L):** The active local replica before
merging a host. Read during per-host merge, never modified by it.

**TERM-SYNC-03 (Host source replica H):** A logical snapshot supplied by
another host through the transport adapter, decoded and validated before the
merge.

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

**DEF-SYNC-01 (Value origin):** Provenance of a final stored value. The origin
of a final value is the `MaterializedCandidate` whose `CandidateId` is selected
by `projectGraph` step 1. Every surviving value (outcome ≠ delete) has
provenance from its selected candidate. Deleted nodes have no final value and
therefore no value origin. The merge basis is the single retained
representation of value origin; no separate origin map is maintained.

**DEF-SYNC-02 (Candidate-input identity):** A materialized value is valid only
against the exact input candidate IDs it records. The final selected value
carries its validity proofs exactly when its recorded input candidate IDs equal
the final selected input candidate IDs for each direct input (`projectGraph`
steps 2-3). Equal timestamps and equal identifiers do not prove equal values
because a recomputation preserves the identifier and `modifiedAt` has finite
resolution. ComputedValue equality, hashing, or serialization must not be used
as identity evidence.

**REQ-SYNC-01 (Value origin from copy, not equality):** Deep equality of
stored values MUST NOT create a value origin.

---

## 3. Synchronization Pipeline

**REQ-SYNC-02 (Normal synchronization):** Normal synchronization follows these
steps in order:

1. The caller holds the required synchronization/lock.
2. The exact local source is frozen/exported into a logical snapshot (its
   frontier advanced only when the host originated new logical state).
3. The transport adapter stores or transmits the exported snapshot and obtains
   the logical snapshots supplied by other hosts.
4. Each supplied logical snapshot is decoded and validated by the transport
   adapter and staged for merging.
5. Each staged logical snapshot is merged into the local database by a per-host
   graph merge.
6. If a per-host merge switches the active replica, the root database is
   reopened before continuing to the next host.
7. Staging storage is cleared after the per-host attempt (whether it succeeded
   or failed).
8. Failures are recorded per host. Synchronization may continue with remaining
   hosts and aggregate failures into a single error report.

**REQ-SYNC-02a (Incorporated-host skip):** Before a staged logical snapshot is
merged, the implementation MUST compare the snapshot's complete causal frontier
against the local source's frontier using `dominatesCausalFrontier` (see
 `incremental-graph-journal-types.md` § Causal frontier and
 `incremental-graph-journal-sync.md` § Synchronization gate). If the local
 frontier dominates the staged frontier, the staged snapshot contains no
 host-originated logical contribution that is new to the local replica, and the
 per-host merge is a **complete no-op**: no destination is constructed, no
 journal event is appended or repositioned, no notification is emitted, the
 watermark is not increased, no new provenance is published, and the
 active-replica pointer MUST remain unchanged. If the staged frontier contains a
 later comparable coordinate for at least one hostname, synchronization may
 proceed. If the frontiers contain a coordinate whose `HostInstanceId` differs
 for the same hostname — a regression within an instance or unrelated storage
 reinitialization — synchronization for that host MUST fail with a
 coordinate-conflict error. The frontier's remote entries are preserved by any
 export taken after ordinary graph activity, so this skip is stable across runs
 while the remote hosts are unchanged. This is what makes synchronization a
 fixed point for unchanged hosts.

**REQ-SYNC-03 (Reset is an ordinary bulk graph procedure):** Reset is not a
synchronization mode with journal semantics of its own. An outer adapter or
orchestration command resolves a hostname to a validated target logical
snapshot; the IncrementalGraph receives only the target graph projection and
applies it through the internal bulk graph operation `replaceGraphState`
(see § 17 Reset as a bulk graph operation). The core graph operation must not
receive or install the target snapshot's journal, watermark, cursor state, or
journal provenance. Reset is one host-originated bulk graph transaction; the
journal records its graph changes through the ordinary emission matrix.

---

## 4. Per-Host Merge Inputs and Preconditions

**TERM-SYNC-14 (Per-host merge inputs):** A per-host merge takes:

- **L**: active local source replica (read-only during merge).
- **H**: staged host source replica (read-only during merge).
- **T**: inactive local target replica (write target; initially a copy of L).

**Preconditions:**

1. The synchronization lock is held for the duration of the merge.
2. H is a single validated logical snapshot supplied by exactly one host.
3. H and the local database have the same schema version. If not, the merge
   for that host MUST fail with a host-version mismatch error.
4. L is not modified by per-host merge.
5. T may be overwritten or refreshed during the merge.
6. H's staging storage is cleared by the caller after the merge attempt.
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

The merge operates over the joined merge basis, not over raw storage
identifiers or source sides.

**DEF-SYNC-03 (Semantic merge domain):** The join operates over semantic node
keys. For each key, `projectGraph(joinedMergeBasis)` (see § 1c) determines the
final candidate, identifier, freshness, validity, and dependency edges; the
result is applied to the target replica T. There is no per-key source-side
selection.

**DEF-SYNC-05 (Final outcome):** For each semantic key, the final outcome is
derived from `projectGraph`:

- `materialized` — a winning `MaterializedCandidate` survives with its value,
  freshness, timestamps, identifier, validity, and dependencies;
- `invalidate` — the winning materialized candidate survives but is
  `potentially-outdated` with incoming proofs removed (the zero/one-input
  direct invalidation policy);
- `delete` — a winning `TombstoneCandidate`, a multi-input direct invalidation
  root, or a dependent of a deleted key; the key has no final identifier,
  value, freshness, timestamps, validity entries, or value origin.

**TERM-SYNC-15 (finalIdentifierForKey):** The partial map from semantic node
keys to their final storage identifiers, derived from the surviving
`MaterializedCandidate` records (each candidate's `identifier`); deleted keys
are absent from the map.

**TERM-SYNC-16 (mergedInputsMap):** The map from each surviving final storage
identifier to its final dependency storage identifiers, lowered through
`finalIdentifierForKey` from the candidate `inputCandidateIds`. Every dependency
of a surviving materialization also survives and has a final identifier; the
delete-propagation closure guarantees this.

---

## 6. Timestamp Conflict Policy

**REQ-SYNC-07 (Canonical candidate selection):** For each semantic key,
`projectGraph` step 1 selects one canonical candidate over the key's retained
candidate set:

- If only one candidate exists, select it.
- If several candidates exist, compare them by the fixed
  `CandidateComparisonKey` tuple `(modifiedAt, NodeIdentifier,
  sourceFingerprint)` and select the maximum:
  1. the newer `modifiedAt` wins;
  2. on equal `modifiedAt`, the lexicographically greater canonical
     `NodeIdentifier` string wins using deterministic JavaScript code-unit
     ordering;
  3. on equal `modifiedAt` and `NodeIdentifier`, the lexicographically greater
     validated source fingerprint wins using deterministic JavaScript code-unit
     ordering.

The maximum is a deterministic function of the candidate set, so the selection
is independent of the grouping or order of the join (§ 1b).
- The comparison MUST NOT prefer a candidate because of its hostname, storage
  instance, or source role.
- Missing timestamps for materialized values are invalid or corrupt state under
  the main graph spec. Synchronization MUST NOT use missing timestamps to
  justify an `up-to-date` final node. It may reject the source or merge
  conservatively invalidate affected nodes, but it must not silently create an
  `up-to-date` value whose timestamp provenance is broken.

**REQ-SYNC-08 (Timestamps are not freshness proofs):** Timestamps select
candidate stored values. They do not by themselves prove that a value is
correct with respect to final merged inputs. Timestamp order is not a semantic
proof of freshness.

**REQ-SYNC-08d (Selected record timestamp copy):** Candidate selection chooses
one complete `MaterializedCandidate` record. The final value, `createdAt`, and
`modifiedAt` are copied from that selected record. Synchronization never
combines the value from one candidate with timestamps from another, never uses
merge execution time as a materialization timestamp, and never computes a
minimum or maximum `createdAt` across candidates.

**REQ-SYNC-08a (modifiedAt is a value version, not a merge timestamp):**
`modifiedAt` records the time at which a node's stored semantic value last
changed as a result of a computor producing a changed value. Merge decisions
and metadata transformations produce no new semantic versions.

- The final `modifiedAt` is the winning candidate's `modifiedAt`.
- Invalidating freshness or rebuilding validity does not change `modifiedAt`.
- Identifier reconciliation, input-edge relowering, and freshness changes do
  not change `modifiedAt`.
- Synchronization MUST NOT manufacture a new `modifiedAt` during merge.
  Every final `modifiedAt` must be one of the timestamps already present in
  the merged candidates.
- Consequently, merging two fixed logical snapshots is independent of merge
  execution time. The result would be identical if the merge ran at any
  future or past time.

**REQ-SYNC-08b (No mergedAt field):** Synchronization MUST NOT introduce a
persistent `mergedAt` field. Sync timing is available through logs.

**REQ-SYNC-08c (Same-coordinate stale freshness):** When two retained
candidates have identical `modifiedAt` and identical `NodeIdentifier` for a
semantic key, the records share a materialization coordinate but not
necessarily a value. The merge MUST be conservative for freshness only:

* If the winning candidate's value is `up-to-date` and a same-coordinate
  candidate's freshness is not `up-to-date`, the final node MUST NOT remain
  `up-to-date`. Set it to `potentially-outdated` without changing `modifiedAt`
  or the winning value.
* If the winning candidate is already not `up-to-date`, no adjustment is
  needed.
* This same-coordinate relation MUST NOT create value provenance, dependency
  history, or validity-proof transport for the non-winning candidate.
* The stale metadata belonging to an older value version (`modifiedAt`)
  MUST NOT taint a strictly newer value version. If one candidate has a newer
  `modifiedAt`, the value selection based on timestamps is authoritative and
  the stale metadata from the older version does not affect the newer
  version's freshness.

---

## 7. Candidate Selection, Direct Invalidation, and Deletion

The merge selects one canonical candidate per semantic key and then decides
freshness, invalidation, and deletion. Every decision below is a deterministic
function of the joined merge basis, so the result is independent of the
grouping or order in which snapshots were merged (§ 1b and § 1c).

**DEF-SYNC-06 (Candidate-input consistency):** A materialized candidate's value
is consistent with the final inputs exactly when its recorded `inputCandidateIds`
equal the final selected candidate IDs for each direct semantic input
(`projectGraph` step 3). This is a property of the candidate record and the
final selection; it does not depend on grouping.

**DEF-SYNC-07 (Direct invalidation candidate):** A selected cached node `K` is a
direct invalidation candidate when its stored value's proof does not carry to
the final state, so its next required recomputation must invoke the computor
rather than accept cache-only revalidation. A key is a direct invalidation
candidate when at least one of:

1. the winning candidate's recorded `inputCandidateIds` do not equal the final
   selected input candidate IDs (direct input relowering below);
2. the final dependency structure of `K` differs from the winning candidate's
   recorded structure;
3. same-coordinate stale freshness metadata from REQ-SYNC-08c applies.

**DEF-SYNC-08 (Direct relowering):** A selected cached node is directly
relowered when at least one distinct semantic direct input used by its winning
`MaterializedCandidate` is not the final selected candidate for that semantic
input. Different storage identifiers, equal timestamps, or equal stored values
do not make a non-matching candidate equivalent. Direct relowering creates a
direct invalidation candidate; it is not by itself a deletion decision.

**REQ-SYNC-09 (Distinct semantic input classifier):** The classifier counts
distinct semantic direct dependency keys. It must not count computor argument
positions, graph-scheme arity, lowered storage identifiers, or validity-edge
count. `X(A)` and `X(A, A)` have one distinct semantic input. `X(A, B)` has two
distinct semantic inputs.

For every direct invalidation candidate:

- zero or one distinct semantic input: retain the winning candidate's value,
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
requires direct hard invalidation, the policy deletes `D`.

**REQ-SYNC-10 (Structural deletion closure):** Deletion roots expand through
transitive materialized dependents in the selected semantic dependency graph. If
`D` is deleted in `A,B → D → E → F`, then `E` and `F` are deleted as
materialized dependents, while `A`, `B`, siblings, and unrelated
materializations such as `U` survive. The closure follows structural semantic
dependencies, not only validity edges, and synchronization never invokes
computors while applying it. Deleted nodes have no final identifier, cached
value, freshness, timestamps, validity entries, or value origin. The deletion
root set is a deterministic function of the joined merge basis (§ 1b, § 1c),
and the closure over the final materialized graph is deterministic, so the
resulting deleted-key set is independent of grouping.

**TERM-SYNC-17 (Propagated staleness):** A node can become
`potentially-outdated` because one of its inputs is stale. That is propagated
staleness, not a direct invalidation candidate. Propagated stale nodes retain
transportable incoming proofs and are not deleted merely because they have
multiple inputs.

---

## 8. Identifier Reconciliation and Edge Lowering

**REQ-SYNC-11 (Final identifier selection):** For each semantic key whose final
outcome is not `delete`, the final identifier is the winning
`MaterializedCandidate`'s `identifier` (`projectGraph` step 9).

The final identifier lookup maps final storage identifiers to semantic keys for
surviving materializations only. It must be bijective between final identifiers
and the set of keys whose final outcome is not `delete`. Deleted keys must not
remain in the lookup.

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

**DEF-SYNC-09 (Candidate validity proof):** A materialized candidate's
`inputCandidateIds` record the exact input candidate IDs against which its value
is valid. A final validity edge `valid[finalD].has(finalN)` is transported from
the winning `MaterializedCandidate` of `N` when that candidate's recorded input
candidate reference for `D` equals the final selected candidate ID for `D`
(`projectGraph` step 8).

**REQ-SYNC-14 (Validity proof transport conditions):** A validity proof is
transported only when ALL of the following hold:

1. The winning candidate of `N` records an `InputCandidateReference` for
   semantic input `D`.
2. The recorded reference equals the final selected candidate ID for `D`.
3. `D` and `N` both have final identifiers in `finalIdentifierForKey`.
4. `finalD` is a direct structural input of `finalN` in the final lowered graph
   per `mergedInputsMap`.
5. The final dependency edge is derived from the final graph scheme and
   semantic inputs, not copied blindly from source storage.

The two endpoints of a transported proof come from one materialized candidate
record. Their final stored byte origins do not need to be the same when
equal-timestamp candidates represent the same temporary semantic versions.

**REQ-SYNC-15 (Negative transport rules):**

- A proof is transported only when the winning candidate's recorded input
  candidate IDs match the final selection; otherwise no proof is transported.
- Proofs involving deleted or discarded candidates MUST NOT be transported.
- Proofs involving unknown semantic keys MUST NOT be transported.
- Proofs involving non-materialized final endpoints MUST NOT be transported.
- Proofs whose final edge is no longer a structural dependency MUST NOT be
  transported.
- Stored value equality MUST NOT be used as a fallback for any endpoint in
  validity proof transport. A proof is transported only through an exact
  candidate-ID match, not on extensional value match.

**REQ-SYNC-16 (Required incoming validity for up-to-date nodes):** Every final
`up-to-date` materialized node must have complete incoming validity proofs for
all its direct inputs. The winning candidate's recorded input candidate IDs plus
the final selection justify complete proof transport for every node that is not
a direct invalidation candidate. Validity reconstruction expects the planning
classification to be complete and throws `UnplannedMissingValidityProofError` if
a missing proof is discovered. Reconstruction does not itself create a new
direct invalidation root.

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
records counts of `projectGraph` outcomes:

- `materialized`: number of semantic keys whose final outcome is `materialized`.
- `invalidated`: number of semantic keys whose final outcome is `invalidate`.
- `deleted`: number of semantic keys whose final outcome is `delete`.

A deletion counts as a semantic graph-state change only when the target replica
previously contained that materialization. A host-only key that is deleted
before ever being written to the target does not by itself change the target
state.

**REQ-SYNC-21 (Switch condition):**

The switch decision covers the complete graph-and-journal destination, not only
the graph semantic state. The inactive replica becomes active if any of the
following differ from the currently active replica:

- graph data, identifier mapping, freshness, or validity metadata;
- journal entries or established journal absences;
- `last_journal_index`;
- `SourceSnapshotProvenance` (the destination's `LogicalSnapshotId`, causal
  frontier, merge protocol version, and schema version);
- any other durable journal or provenance metadata.

The active pointer remains unchanged only when the complete installed state
already matches the reconciled destination — graph data, journal entries,
established absences, `last_journal_index`, and source-snapshot provenance
included. In particular, a journal-only difference (for example a higher
`last_journal_index` that covers established or known-absent synchronized
positions, or a different merged provenance) is sufficient to switch replicas.
This installs the reconciled journal and its watermark, so that no future local
index allocation can reuse or overwrite a position another synchronized host has
already established or retired, and so that the derived merge provenance can
become the source of the next per-host merge.

When the frontier-dominance gate of REQ-SYNC-02a makes the per-host merge a
complete no-op, no destination is constructed and the active-replica pointer
MUST remain unchanged: the installed state already matches, and no reconciled
destination exists to switch to. In particular, the switch rule MUST NOT switch
the active replica for an already incorporated unchanged host.

A "metadata-only" change, such as importing a valid provenance-backed
validity proof, is sufficient to switch replicas, because it affects future
recomputation behavior. Metadata-only changes must obey the provenance rules
of §11.

Journal reconciliation (see `incremental-graph-journal-sync.md`) runs
downstream of graph planning and constructs the destination journal and
provenance; its output participates in this switch decision exactly like graph
state.

**REQ-SYNC-22 (Partial failure safety):** The currently active local source
replica must not be partially mutated by a failed host merge. Failure before
commit must not leave callers reading from an invalid partial merge target.

---

## 14. Multi-Host Synchronization

**REQ-SYNC-23 (Logical-join commutativity and associativity):** For valid source replicas using the same schema, the merge is a commutative, associative, and idempotent logical join (§ 1b): `merge(A, B) = merge(B, A)`, `merge(merge(A, B), C) = merge(A, merge(B, C))`, and `merge(A, A) = A`. Observable equivalence includes semantic keys, selected identifiers, stored values, freshness, timestamps, lowered inputs, reverse dependencies, validity proofs, deletion outcomes, and invalidation outcomes. It excludes host-local allocator capability metadata: each host intentionally retains its own `fingerprint` and `last_node_index` allocation namespace. It may also ignore local physical details such as temporary paths, logs, replica-slot names, and source-role labels.

**REQ-SYNC-24 (Sequential per-host merge):** Normal synchronization may merge
multiple staged host snapshots sequentially. Because the merge is a canonical
logical join, the final state is independent of the order of those per-host
merges; each per-host merge still observes the result of prior successful
per-host merges.

**REQ-SYNC-25 (Per-host validation after success):** The implementation MUST
validate the graph state after every successful per-host merge against the
invariants in §12 before proceeding to the next host.

**REQ-SYNC-26 (Host failure isolation):** If one host's merge fails,
synchronization may continue with remaining hosts and aggregate all failures
into a single composite error.

**REQ-SYNC-27 (Join order independence):** Because the merge is a canonical
logical join (§ 1b), it is commutative and associative: the final state after
merging a set of host snapshots is the same regardless of the order or grouping
of per-host merges. Each individual per-host merge still satisfies the
invariants of §12 at the moment it completes, and the final state after all host
merges (successful or skipped) is a valid IncrementalGraph state from which all
future public operations produce results consistent with the main
IncrementalGraph spec.

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

**PROP-SYNC-05 (Join determinism):** The graph-and-journal merge is a canonical
logical join: `merge(A, B) = merge(B, A)`, `merge(merge(A, B), C) =
merge(A, merge(B, C))`, and `merge(A, A) = A` over all synchronization-relevant
logical state. Two replicas that represent the same host-originated logical
contributions, received in any grouping or order, converge to equal logical
merge state.

---

## 16. Testable scenarios

### G1 — Associativity across two groupings

Snapshots `A`, `B`, `C` are valid and share a schema and protocol.
`merge(merge(A, B), C)` and `merge(A, merge(B, C))` produce equal logical state:
equal graph materializations and selected values, freshness, identifiers,
dependency and validity state, deletion and invalidation outcomes, canonical
journal state, causal frontier, merge basis, and `LogicalSnapshotId`.

### G2 — All six processing orders of three snapshots

Merging `A`, `B`, `C` in each of the six orders
`ABC, ACB, BAC, BCA, CAB, CBA` produces the same final logical state.

### G3 — One-input invalidation roots under different groupings

`A → D` with a single distinct semantic input: whichever grouping is used,
`D` is retained as a hard invalidation candidate (value kept,
`potentially-outdated`, incoming proofs removed), never deleted, and the final
logical state is identical across groupings.

### G4 — Multi-input deletion roots under different groupings

`A, B → D` with two distinct semantic inputs: whichever grouping is used, a
direct invalidation candidate `D` is deleted (no final identifier, value,
freshness, timestamps, validity entries, or value origin), and the deletion
closure over the final materialized graph deletes the same transitive dependent
set across groupings.

### G5 — Conflicting values with equal and unequal modifiedAt

Two snapshots contribute different values for the same key. With unequal
`modifiedAt`, the newer `modifiedAt` wins in every grouping. With equal
`modifiedAt` and equal identifier, the same-coordinate conservative rule
(REQ-SYNC-08c) applies identically in every grouping; with equal `modifiedAt`
and different identifiers, the canonical `(modifiedAt, NodeIdentifier,
sourceFingerprint)` tuple determines the winner identically.

### G6 — Different pre-existing journal placement and compaction histories

Two replicas represent the same host-originated contributions but have
physically different journal placement (different indices, different
compaction-removed absences). Merging either replica with a third snapshot
produces the same canonical journal state and the same `LogicalSnapshotId`:
physical placement and compaction are not part of the logical join result.

### G7 — Three-host fixed point under different arrival orders

Hosts `A`, `B`, `C` reach the fixed-point frontier
`{ A: {IA, vA}, B: {IB, vB}, C: {IC, vC} }`. If each host then supplies its
snapshot to a peer in any order, every synchronization attempt whose staged
frontier is dominated by the local frontier is a complete no-op, and the
resulting logical state is identical.

### G8 — Equal frontiers imply equal logical merge state

Two replicas with equal causal frontiers exchange snapshots. Because both
represent the same host-originated logical contributions, the logical merge
state — including the `LogicalSnapshotId` — is equal after the exchange. Their
physical storage may differ (compaction, index layout); that is not part of the
join.

### G9 — A real new contribution propagates once after the three-host fixed point

After the three-host fixed point, host `C` performs a real host-local graph or
journal mutation and advances to `IC/vC+1`. Whichever peer incorporates `C`'s
new snapshot first, the new contribution propagates exactly once to every
replica, and the mesh reaches a new fixed point
`{ A: {IA, vA}, B: {IB, vB}, C: {IC, vC+1} }`.

### G10 — Fully enumerated merge-basis trace: join(join(A,B),C) versus join(A,join(B,C))

Setup. Three snapshots over keys `K` and `D` (`D` depends on `K`):

- `A` originates `K = v1` at origin `a = (A, IA, 1)`, so
  `candA = MaterializedCandidate{ candidateId: id(a,K), origin: a, semanticKey: K,
  kind: "materialized", value: v1, timestamps: (t1,t1), identifier: n1,
  inputCandidateIds: [], freshness: "up-to-date", comparisonKey: (t1,n1,fA) }`.
- `B` originates `K = v2` at origin `b = (B, IB, 1)`, so
  `candB = MaterializedCandidate{ candidateId: id(b,K), origin: b, semanticKey: K,
  kind: "materialized", value: v2, timestamps: (t2,t2), identifier: n2,
  inputCandidateIds: [], freshness: "up-to-date", comparisonKey: (t2,n2,fB) }`,
  with `(t2,n2,fB) > (t1,n1,fA)`.
- `C` originates `D = w` at origin `c = (C, IC, 1)`, computed against `K = v2`,
  so
  `candC = MaterializedCandidate{ candidateId: id(c,D), origin: c, semanticKey: D,
  kind: "materialized", value: w, timestamps: (t3,t3), identifier: n3,
  inputCandidateIds: [ { semanticKey: K, candidateId: id(b,K) } ],
  freshness: "up-to-date", comparisonKey: (t3,n3,fC) }`.

**First grouping — `join(join(A, B), C)`.**

`M1 = joinMergeBasis(A, B)` persists exactly:

```
key K: candidates = { candA, candB }
       freshness  = { FreshnessFact{origin: a, tone: up-to-date, time: t1},
                      FreshnessFact{origin: b, tone: up-to-date, time: t2} }
       conflicts  = { candA, candB }
key D: (empty)
```

`projectGraph(M1)`: `K`'s winner is `candB` (its comparison key is larger).
`candB` has no input candidate references, so it is consistent with the final
inputs; `K` is `up-to-date`.

`M2 = joinMergeBasis(M1, C)` persists:

```
key K: candidates = { candA, candB }
       freshness  = { a: up-to-date@t1, b: up-to-date@t2 }
key D: candidates = { candC }
       freshness  = { c: up-to-date@t3 }
       conflicts  = { candC }
```

`projectGraph(M2)`: `D`'s winner is `candC`; its recorded input candidate for
`K` is `id(b,K)`, which equals the final selected `K` candidate (`candB`), so
`D` is consistent, not a direct invalidation candidate, and is `up-to-date`.

**Second grouping — `join(A, join(B, C))`.**

`N1 = joinMergeBasis(B, C)` persists:

```
key K: candidates = { candB }
       freshness  = { b: up-to-date@t2 }
key D: candidates = { candC }
       freshness  = { c: up-to-date@t3 }
       conflicts  = { candC }
```

`N1` retains `candB` (the `K` winner and the input of `candC`) and `candC` with
its exact input candidate reference `id(b,K)`. `candA` is not present, which is
correct: it has not been introduced.

`N2 = joinMergeBasis(A, N1)` joins `candA` into `N1`:

```
key K: candidates = { candA, candB }
       freshness  = { a: up-to-date@t1, b: up-to-date@t2 }
key D: candidates = { candC }
       freshness  = { c: up-to-date@t3 }
       conflicts  = { candC }
```

`projectGraph(N2)` selects `candB` for `K` (larger comparison key), verifies
`candC`'s recorded input candidate `id(b,K)` matches the final `K` winner, and
produces the same graph as `projectGraph(M2)`.

`M2` and `N2` persist the identical candidate, freshness, validity, and conflict
evidence, so `projectGraph(M2) = projectGraph(N2)` and the two groupings yield
the same merge basis, the same projected graph, and the same `LogicalSnapshotId`.

This trace covers:

- **Conflicting values:** `candA` versus `candB` are both retained in `M2` and
  `N2` and compared by the same canonical tuple.
- **Winning value whose inputs come from different hosts:** `candC`'s value was
  computed against `candB` (host B), and the join retains that exact input
  candidate reference so the consistency check is possible in either grouping.
- **One-input hard invalidation:** had `candC`'s recorded input candidate not
  matched the final `K` winner, `D` (one distinct input) would be hard-invalidated
  in both groupings.
- **Multi-input deletion:** a direct invalidation candidate with two distinct
  inputs would yield a derived tombstone in both groupings.
- **Deletion tombstones:** deletions are ordered `TombstoneCandidate` records in
  the basis, never missing storage.
- **Validity proof transport:** a proof is transported only when the candidate's
  recorded input candidate ID matches the final selection.
- **Stale evidence:** a host-originated stale `FreshnessFact` is retained while
  it could affect a future join and combined monotonically.
- **Compaction-independent journal evidence:** journal events are retained as
  immutable payloads in the logical journal view, independent of physical
  compaction.

---

## 17. Reset as a Bulk Graph Operation

Reset is an ordinary graph procedure with no journal semantics of its own. An
outer adapter or orchestration command resolves a hostname to a validated
target logical snapshot and supplies only its graph projection to
IncrementalGraph, which applies it through an internal bulk graph operation
conceptually equivalent to:

```text
replaceGraphState(targetGraphState)
```

The core graph operation must not receive or install the target snapshot's
journal, watermark, cursor state, or journal provenance. Reset is one
host-originated bulk graph transaction.

Before publishing anything, the operation computes the complete semantic delta
between the currently installed graph and the target graph. For each semantic
node key the delta yields zero or one of `add`, `delete`, `edit`, `invalidate`,
or `validate`, according to the single transition-to-event matrix in
`incremental-graph-journal-emission.md` § Transition-to-event matrix. When more
than one condition applies, the matrix defines the combined events and their
order.

The target graph must be validated before publication: materialization closure
holds; the identifier lookup is bijective; every `up-to-date` node has all
required materialized, `up-to-date` inputs; validity proofs match the target
dependencies; deleted nodes have no remaining values, freshness, timestamps,
identifiers, dependency records, or validity records; no computor is invoked.

A changed key must also produce the ordinary graph merge-basis candidate or
tombstone required for future synchronization; a reset deletion must create the
same durable deletion evidence as any other host-local deletion, never be
represented merely by absence.

The entire operation is published atomically. If the destination is built in an
inactive replica: copy the existing journal prefix and watermark unchanged,
build the new graph state, append reset-generated journal entries at fresh
indices above the old watermark, persist the one successor `HostStateVersion`,
and switch only after the complete destination is durable and validated. A
successful changed reset advances the local `HostStateVersion` exactly once,
regardless of how many nodes and journal entries it changes.

Journal and cursor continuity: reset preserves every established journal
position and absence, appends only above the current watermark, never decreases
`last_journal_index`, preserves the existing `JournalCursorDomain`, keeps
existing `PossibleNodeChange` cursors valid, and preserves the local
`HostInstanceId`. Reset is not journal compaction, synchronization
normalization, migration, or journal replacement. A no-op reset emits no
journal entries, advances no watermark and no host version, and performs no
replica switch. A failed reset leaves graph state, journal state, watermark,
host version, active replica, and existing cursor validity unchanged.
