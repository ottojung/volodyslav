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

NodeIdentifier uniqueness is established by existing allocation contract: accepted-negligible-collision `DatabaseFingerprint` namespace plus strictly monotone non-reused local allocation index. Replay does not establish global uniqueness by scanning all historical ValueEvents.

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

Node-scoped invalidation remains relevant across value changes until later validation causally covers it.

Value-scoped invalidation applies only to named ValueId and stops affecting projection when another ValueId becomes current.

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

Thus node-scoped invalidation destroys applicability of every certificate which did not causally observe it.

This eligibility rule is also the mechanism used by reset/migration **proof barriers**: when maintenance must weaken proof for a preserved ValueId, it authors node-scoped invalidation before target validation. Older stronger certificates remain retained but become ineligible, so their greater `basisMatchCount` cannot reintroduce removed validity.

## Current basis-match count

For eligible C:

```text
basisMatchCount(K,C) =
    number of D in currentInputEdges(K) such that
        basisValue(C,D) == valueId(D)
```

`"unknown"` contributes no match.

## Certificate selection

Journal 3 retains all certificates, so replay chooses strongest sound current proof rather than letting concurrent clock tie-break hide causally later revalidation.

Choose exactly one certificate:

```text
certificate(K) = eligible C maximizing lexicographically:
    1. basisMatchCount(K,C)
    2. coversValueInvalidations(K,C)
       where true > false
    3. authorityCompare(C, ...)
```

If no eligible certificate, K has no current certificate.

Second key is essential. Suppose C2 causally follows/covers value-scoped invalidation of current ValueId, while concurrent C1 has same full basis but greater clock-derived authority. C2 must win because it contains stronger causal proof about current occurrence.

Authority remains deterministic tie-break only among certificates with equal basis applicability and equal current-value-invalidation coverage.

Replay never synthesizes certificate by combining entries from different validations.

For ordinary single-writer evolution, latest successful validation normally has complete current input basis, covers prior invalidations, and wins naturally.

## Incoming validity edge

For current structural edge `D -> K`:

```text
edgeValid(D,K) iff
    present(D)
    and present(K)
    and certificate(K) exists
    and basisValue(certificate(K), D) == valueId(D)
```

A value-scoped invalidation does not by itself remove incoming validity proof. This preserves distinction between proof validity and persistent stale freshness.

Legacy inverse relation is:

```text
nodeIdentifier(K) in valid[nodeIdentifier(D)]
    iff edgeValid(D,K)
```

All validity edges for K come from one selected certificate.

## Freshness

Freshness is derived recursively over current schema DAG.

For present K:

```text
fresh(K) iff
    certificate(K) exists
    and basisMatchCount(K, certificate(K))
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
- reset when source target stores persistent stale state;
- migration when migration target stores persistent propagated stale state.

A node currently stale for a different persistent own-state reason—basis mismatch, uncovered node invalidation, or already-uncovered current-value invalidation—does not require duplicate value marker merely because replay says stale.

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

WriterState values must be monotone nondecreasing.

Foreign writer-state records do not change this database's local watermark.

Before continuing local allocation after restoration/migration, reconstructed watermark preserves monotone allocator invariant so retired local index cannot be reused.

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
