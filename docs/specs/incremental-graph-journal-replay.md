# IncrementalGraph Journal 3 Replay and Projection

## Purpose

This document defines deterministic projection from supported Journal 3 history into existing persisted IncrementalGraph representation.

The journal is authoritative. Legacy graph sublevels are a materialized view.

Projection is defined semantically over retained journal history. An implementation may maintain equivalent indexes incrementally and is not required to rescan all retained history after every operation.

## Inputs to replay

Core current-state replay operates under one compatible current database version and graph schema:

```text
project(
    journal: JournalReplica,
    localWriter: JournalAuthor,
    currentGraphSchema
)
```

`localWriter` identifies database whose host-local allocator projection is reconstructed. It does not affect semantic conflict selection.

Before replay, retained journal must satisfy:

- stream identity/prefix contiguity;
- decoding under one canonical journal format selected by current `global/version`;
- timestamp/authority invariants;
- transitively closed causal contexts; and
- cross-record rules in `incremental-graph-journal-well-formedness.md`.

Replay never performs per-record version dispatch, upcasting, or downcasting. If database version changes, migration first rewrites complete retained journal into target current representation.

Current schema defines current structural `inputEdges(K)` and persisted `graph_scheme` lowering. It is not additional mutable synchronization authority.

Historical ValidateEvents are self-describing with explicit input NodeKeys. Their persisted representation has already been rewritten into current database format by any intervening migration.

## Semantic history of one node

For semantic `NodeKey K`:

```text
History(K) = all retained SemanticEvents whose node == K
```

Journal 3 retains this history rather than replacing it with compacted summary.

## Semantic value/absence head

Define:

```text
HeadCandidates(K) =
    ValueEvents(K) union DeleteEvents(K)
```

If empty, K has no semantic head and is absent.

Otherwise:

```text
head(K) = greatest HeadCandidate by authorityCompare
```

If head is DeleteEvent, K is absent.

If head is ValueEvent:

```text
valueId(K)        = head(K).id
payload(K)        = head(K).payload
nodeIdentifier(K) = head(K).nodeIdentifier
createdAt(K)      = head(K).createdAt
modifiedAt(K)     = head(K).modifiedAt
```

A losing ValueEvent remains historical but supplies no current payload merely because its payload is deeply equal to winner.

## Raw selected-head view

For maintenance which must repair a compatible raw Journal union **before** that union is structurally projectable, define:

```text
selectedHeads(J)
```

as exactly the deterministic ValueEvent/DeleteEvent head selection above for every semantic NodeKey in J.

For each K it exposes only:

- whether the selected head is ValueEvent, DeleteEvent, or absent;
- the selected head's JournalRecordId/ValueId when applicable; and
- for a selected ValueEvent, its immutable occurrence fields: NodeIdentifier, payload, createdAt, modifiedAt.

`selectedHeads(J)` does **not** require dependency closure and does not evaluate certificates, validity, freshness, or graph materializability. It is therefore not a graph projection, not publishable state, and MUST NOT be substituted for `project(J)` after structural repair.

Its purpose is narrow: synchronization, reset, and other maintenance may inspect deterministic raw head winners in staging storage in order to author the semantic records that make the selected head set structurally projectable.

## Dependency closure is a publishable-state condition

Legacy IncrementalGraph requires materialized nodes to be dependency-closed under current schema.

Every supported committed current projection satisfies:

```text
head(K) is ValueEvent
    => for every D in currentInputEdges(K):
        head(D) is ValueEvent
```

A raw journal union may temporarily violate this while synchronization constructs inactive target. That union is not publishable yet.

Synchronization/reset/migration normalization authors explicit semantic removal authority as required before cutover.

Journal 3 does not silently hide selected ValueEvent from legacy graph while leaving latent current cache which could reappear automatically. Structural removal is explicit history.

After normalization:

```text
present(K) iff head(K) is ValueEvent
```

## Physical identifier consistency

Every present K uses `NodeIdentifier` carried by selected ValueEvent.

NodeIdentifier uniqueness is established by the allocation contract in `incremental-graph-journal-types.md` §NodeIdentifier uniqueness basis: an accepted-negligible-collision `DatabaseFingerprint` namespace plus a local allocation index which is never reallocated while the earlier allocation can exist in or later enter supported retained history. Replay does not establish global uniqueness by scanning all historical ValueEvents.

If two distinct present NodeKeys nevertheless select same incompatible physical NodeIdentifier, projection fails as unsupported/corrupt current state.

Final `identifiers_keys_map` must be bijective over current present keys.

## Invalidation coverage

For semantic events I and C:

```text
coveredBy(I,C) iff happenedBefore(I,C)
```

A concurrent validation does not clear invalidation merely because total AuthorityTime compares later.

For K and validation C:

```text
uncoveredNodeInvalidation(K,C) iff
    exists InvalidateEvent I in History(K) such that
        I.scope.kind == "node"
        and not happenedBefore(I,C)
```

For validation C targeting one exact ValueId and one direct input D:

```text
uncoveredProofBarrier(K,D,C) iff
    exists InvalidateEvent I in History(K) such that
        I.scope.kind == "proof"
        and I.scope.value == C.value
        and I.scope.input == D
        and not happenedBefore(I,C)
```

For current value V(K) and validation C:

```text
uncoveredValueInvalidation(K,C) iff
    exists InvalidateEvent I in History(K) such that
        I.scope.kind == "value"
        and I.scope.value == valueId(K)
        and not happenedBefore(I,C)
```

Define:

```text
coversValueInvalidations(K,C) iff
    not uncoveredValueInvalidation(K,C)
```

The scopes are intentionally different:

- node-scoped invalidation remains relevant across value changes until a validation causally covers it;
- proof-scoped invalidation removes one incoming proof edge for one exact ValueId until a validation causally covers that edge barrier and re-proves the edge;
- value-scoped invalidation affects persistent freshness only for its named ValueId and does not remove incoming validity proof by itself.

Proof barriers are **negative edge evidence**, not whole-certificate invalidations. This is essential for independent maintenance: concurrent barriers for the same V can remove different edges without making every independently authored target certificate unusable.

## Current validation candidates

For present K:

```text
Validations(K) = {
    C | C is ValidateEvent
        and C.node == K
        and C.value == valueId(K)
}
```

Every retained C is already assumed well formed historical evidence.

For current projection define:

```text
currentInputs(K) = set(currentInputEdges(K))
certificateInputs(C) = set(entry.input for entry in C.basis)
```

A validation is **current-shape-compatible** iff:

```text
certificateInputs(C) == currentInputs(K)
```

Because basis input NodeKeys are explicit, order changes alone do not invalidate certificate; input-set changes do.

A supported Journal-aware schema migration establishes proof state compatible with target schema. It may preserve current ValueId when migration preserves semantic occurrence; schema change alone does not require new occurrence.

A validation for current ValueId with different historical input set remains inspectable history but is not current structural proof.

## Basis lookup

Because basis input keys are unique:

```text
basisValue(C,D) =
    C.basis entry with input == D .value
```

for D in `certificateInputs(C)`.

For current-shape-compatible certificate this is defined for every direct input.

`"unknown"` is defined basis value but never equals current ValueId.

## Eligible certificate

A certificate can be selected for current proof only when:

```text
eligibleCertificate(K,C) iff
    C in Validations(K)
    and current-shape-compatible(C,K)
    and not uncoveredNodeInvalidation(K,C)
```

Thus true node invalidation rejects every certificate which did not causally observe it, regardless of occurrence.

Proof barriers do **not** make the whole certificate ineligible. They are applied to individual basis edges below. This lets one certificate continue to prove unaffected inputs while maintenance retires only the exact incoming edges it intended to weaken.

## Effective basis match

For eligible C and direct input D:

```text
basisEntryEffective(K,C,D) iff
    basisValue(C,D) == valueId(D)
    and not uncoveredProofBarrier(K,D,C)
```

Then:

```text
effectiveBasisMatchCount(K,C) =
    number of D in currentInputEdges(K) such that
        basisEntryEffective(K,C,D)
```

For maintenance reasoning also define the effective proof edges of one eligible certificate and their union across all eligible retained certificates for the selected occurrence:

```text
effectiveProofEdges(K,C) = {
    D in currentInputEdges(K)
    | basisEntryEffective(K,C,D)
}

eligibleEffectiveProofUnion(K) =
    union effectiveProofEdges(K,C)
    over every eligibleCertificate(K,C)
```

`eligibleEffectiveProofUnion(K)` is **not** replay's positive validity relation. Replay still selects exactly one certificate and never combines positive proof. The union is only a maintenance analysis set: it identifies every incoming edge that some already-retained eligible certificate could expose if certificate selection changes after proof weakening.

`"unknown"` contributes no match.

A proof barrier for `(V,D)` is cleared for one certificate only when that certificate causally observes the barrier. A concurrent certificate may still prove other inputs, but it cannot re-establish D merely by having greater clock authority.

## Certificate selection

Journal 3 retains all certificates, so replay chooses strongest sound current proof rather than letting concurrent clock tie-break hide causally later revalidation.

Choose exactly one certificate:

```text
certificate(K) = eligible C maximizing lexicographically:
    1. effectiveBasisMatchCount(K,C)
    2. coversValueInvalidations(K,C)
       where true > false
    3. authorityCompare(C, ...)
```

If no eligible certificate, K has no current certificate.

Second key is essential. Suppose C2 causally follows/covers value-scoped invalidation of current ValueId, while concurrent C1 has the same effective basis strength but greater clock-derived authority. C2 must win because it contains stronger causal proof about current occurrence.

Authority remains deterministic tie-break only among certificates with equal effective basis applicability and equal current-value-invalidation coverage.

Replay never synthesizes positive proof by combining entries from different validations. Multiple proof barriers may, however, independently remove edges from the selected certificate; that is accumulation of negative evidence, not certificate mixing.

For ordinary single-writer evolution, latest successful validation normally has complete current input basis, covers prior invalidations/barriers, and wins naturally.

## Incoming validity edge

For current structural edge `D -> K`:

```text
edgeValid(D,K) iff
    present(D)
    and present(K)
    and certificate(K) exists
    and basisEntryEffective(K, certificate(K), D)
```

A value-scoped invalidation does not by itself remove incoming validity proof. This preserves distinction between proof validity and persistent stale freshness.

Legacy inverse relation is:

```text
nodeIdentifier(K) in valid[nodeIdentifier(D)]
    iff edgeValid(D,K)
```

All positive validity edges for K come from one selected certificate. Proof barriers may only remove edges from that certificate.

## Freshness

Freshness is derived recursively over current schema DAG.

For present K:

```text
fresh(K) iff
    certificate(K) exists
    and effectiveBasisMatchCount(K, certificate(K))
        == currentInputEdges(K).length
    and coversValueInvalidations(K, certificate(K))
    and for every D in currentInputEdges(K):
        present(D)
        and fresh(D)
```

For zero-input node, full-basis/input condition is vacuous; it still requires eligible certificate covering all current-value invalidations.

Legacy freshness projection is:

```text
freshness[nodeIdentifier(K)] = "up-to-date"
    iff fresh(K)

freshness[nodeIdentifier(K)] = "potentially-outdated"
    iff present(K) and not fresh(K)
```

## Persistent propagated staleness

Existing flag-based algorithm requires propagated stale state to persist even if upstream node later revalidates unchanged.

Journal records that transition using value-scoped InvalidateEvent for affected cached occurrence.

Therefore replay does not make stale dependent fresh merely because all inputs later become fresh again. Dependent itself needs causally later validation covering its stale marker.

Every authoring path which intentionally creates/reproduces a persistent fresh-to-stale flag must ensure this marker exists when the occurrence's own proof is otherwise complete:

- ordinary emission for runtime propagated invalidation;
- synchronization normalization for merged-input staleness;
- pre-Journal bootstrap join when combined canonical/joining evidence makes a selected occurrence stale solely through a stale input;
- reset when source target stores persistent stale state;
- migration when migration target stores persistent propagated stale state.

Bootstrap additionally treats an **exact shared occurrence** conservatively: if either canonical or joining legacy copy was stale, the joined shared ValueId retains an uncovered value-scoped bootstrap invalidation. A fresh joining copy cannot causally validate away canonical stale evidence merely by upgrading later.

A node currently stale for a different persistent own-state reason—basis mismatch, uncovered node invalidation, an effective-basis deficit caused by proof barriers, or already-uncovered current-value invalidation—does not require duplicate value marker merely because replay says stale.

## Lowering to existing graph storage

Let:

```text
PresentKeys = { K | present(K) }
```

### identifiers_keys_map

For every K in PresentKeys:

```text
identifiers_keys_map[nodeIdentifier(K)] = K
```

and no other entries.

### values

For every K in PresentKeys:

```text
values[nodeIdentifier(K)] = payload(K)
```

### timestamps

For every K in PresentKeys:

```text
timestamps[nodeIdentifier(K)] = {
    createdAt: serializeCanonical(createdAt(K)),
    modifiedAt: serializeCanonical(modifiedAt(K))
}
```

Semantic timestamp is exact instant carried by selected ValueEvent; replay does not substitute current time.

### freshness

Write freshness state derived above for every present K.

### valid

For every current structural edge D -> K, include K's selected identifier in `valid[D]` exactly when `edgeValid(D,K)`.

No validity entry may mention absent/losing identifier.

### graph_scheme / structural dependency relation

Structural dependencies are derived from current application/schema interpretation exactly as existing graph design.

Persisted current `graph_scheme` is lowering of current schema/version contract. Journal history does not treat mutable `graph_scheme` bytes as conflict authority.

Schema migration establishes current proof/freshness state compatible with target schema before target becomes active.

## Host-local allocation watermark

For local writer A:

```text
WriterState(A) = all WriterStateRecords authored by A
```

If none, replay uses defined initial local `last_node_index` (currently zero).

Otherwise:

```text
last_node_index =
    lastNodeIndex from greatest A-local WriterStateRecord by sequence
```

WriterState values must be monotone nondecreasing within the retained writer stream being replayed.

Foreign writer-state records do not change this database's local watermark.

Before continuing local allocation, the reconstructed watermark must cover every local index retired by the retained local-writer history. Migration preserves retained history and therefore preserves that watermark. Continuation-safe absent restoration may reconstruct an older watermark together with an older writer prefix; indices allocated only in the discarded suffix may be reallocated exactly when `incremental-graph-journal-lifecycle.md` §4.1 guarantees that suffix cannot later enter supported retained history.

## Replay equality

Two current projections are semantically equivalent when they agree on:

- current present semantic NodeKeys;
- selected ValueId for every present node;
- exact payload;
- createdAt/modifiedAt;
- selected NodeIdentifier;
- freshness;
- semantic validity edges;
- local writer last_node_index when comparing same local-writer projection; and
- current schema-derived structural representation required by graph storage contract.

Temporary paths, inactive replica-slot names, transport metadata, LevelDB internal sequence numbers, and derived Journal index layouts are excluded.

## Replay algorithms

Definitions above are declarative.

A conforming implementation may use whole-history replay, incremental folding, per-node indexes, verified replay checkpoints, or another observationally equivalent algorithm.

Record arrival order must not change final result for one final supported journal.

A clear whole-history/reference path should remain available as test oracle.

## Replay checkpoint correctness

A checkpoint names exact JournalFrontier F and contains derived state equivalent to replaying history through F under compatible schema/current database interpretation.

Usable only when:

```text
checkpointProjection == project(journal through F)
```

Checkpoint loss is harmless to authority. Authoritative journal-record loss is not.

Database format migration may discard/rebuild checkpoints rather than versioning independently.

## Corruption/inconsistency handling

Replay/import rejects rather than guesses on writer holes, same-ID disagreement, wrong current format, non-closed contexts, impossible references, malformed bases/timestamps, invalid NodeIdentifier reuse, decreasing writer state, non-dependency-closed selected heads, or persisted graph disagreement.

Payload equality is never repair mechanism for journal identity, reference, or provenance conflicts.
