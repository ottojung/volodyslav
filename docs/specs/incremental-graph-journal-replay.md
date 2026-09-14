# IncrementalGraph Journal 3 Replay and Projection

## Purpose

This document defines the deterministic projection from supported Journal 3 history into the existing persisted IncrementalGraph representation.

The journal is authoritative. The legacy graph sublevels are a materialized view.

The projection is defined semantically over immutable journal history. An implementation may maintain equivalent indexes incrementally and is not required to rescan all retained history after every operation.

## Inputs to replay

Core current-state replay operates under one compatible current database version and graph schema:

```text
project(
    journal: JournalReplica,
    localWriter: JournalAuthor,
    currentGraphSchema
)
```

`localWriter` identifies the database whose host-local allocator projection is being reconstructed. It does not affect semantic conflict selection.

Before replay, the retained journal must satisfy:

- stream identity/prefix contiguity;
- immutable-record/version decoding;
- timestamp/authority invariants;
- causal closure; and
- the cross-record rules in `incremental-graph-journal-well-formedness.md`.

The current schema is application/version interpretation, not an additional mutable synchronization authority. It defines current structural `inputEdges(K)` and the persisted `graph_scheme` lowering.

Historical ValidateEvents are self-describing with explicit input NodeKeys, so merely decoding old certificate claims does not require historical schema ordering.

## Semantic history of one node

For semantic `NodeKey K`:

```text
History(K) = all retained SemanticEvents whose node == K
```

Journal 3 retains this history rather than replacing it with a compacted summary.

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

If `head(K)` is DeleteEvent, K is absent.

If it is ValueEvent, K has a present semantic head and:

```text
valueId(K)        = head(K).id
payload(K)        = head(K).payload
nodeIdentifier(K) = head(K).nodeIdentifier
createdAt(K)      = head(K).createdAt
modifiedAt(K)     = head(K).modifiedAt
```

A losing ValueEvent remains historical but supplies no current payload merely because its payload is deeply equal to the winner.

## Dependency closure is a publishable-state condition

The legacy IncrementalGraph requires materialized nodes to be dependency-closed under the **current** schema.

Therefore every supported committed current projection satisfies:

```text
head(K) is ValueEvent
    => for every D in currentInputEdges(K):
        head(D) is ValueEvent
```

A raw journal union may temporarily violate this while synchronization constructs an inactive target. That union is not publishable yet.

Synchronization/reset/migration normalization must author explicit semantic removal authority as required by their specifications before cutover.

Journal 3 does not silently hide a selected ValueEvent from the legacy graph while leaving it as a latent current cache that could reappear automatically. Structural removal is explicit history, preserving ordinary `oldValue` semantics.

After normalization:

```text
present(K) iff head(K) is ValueEvent
```

## Physical identifier consistency

Every present K uses the `NodeIdentifier` carried by its selected ValueEvent.

If two distinct present semantic NodeKeys select the same incompatible physical NodeIdentifier, projection fails as unsupported/corrupt current state.

The final `identifiers_keys_map` must be bijective over current present keys.

## Invalidation coverage

For semantic events I and C:

```text
coveredBy(I,C) iff happenedBefore(I,C)
```

A concurrent validation does not clear an invalidation merely because its total AuthorityTime compares later.

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

Node-scoped invalidation remains relevant across value changes until a later validation causally covers it.

Value-scoped invalidation applies only to the named ValueId and stops affecting projection when another ValueId becomes current.

## Current validation candidates

For present K:

```text
Validations(K) = {
    C | C is ValidateEvent
        and C.node == K
        and C.value == valueId(K)
}
```

Every retained C is already assumed well formed as historical evidence.

For current projection define:

```text
currentInputs(K) = set(currentInputEdges(K))
certificateInputs(C) = set(entry.input for entry in C.basis)
```

A validation is **current-shape-compatible** iff:

```text
certificateInputs(C) == currentInputs(K)
```

Because basis input NodeKeys are explicit, order changes alone do not invalidate a certificate; input-set changes do.

A supported Journal-3-aware schema migration creates new migration ValueIds/certificates for target-present nodes, so an old-schema certificate is not expected to be the only certificate for a selected current migration ValueId.

A validation for the current ValueId with a different historical input set remains inspectable history but is not current structural proof.

## Basis lookup

Because basis input keys are unique, define:

```text
basisValue(C,D) =
    C.basis entry with input == D .value
```

for D contained in `certificateInputs(C)`.

For a current-shape-compatible certificate this is defined for every direct current input.

`"unknown"` is a defined basis value but never equals a current ValueId.

## Eligible certificate

A certificate can be selected for current proof only when:

```text
eligibleCertificate(K,C) iff
    C in Validations(K)
    and current-shape-compatible(C,K)
    and not uncoveredNodeInvalidation(K,C)
```

Thus a node-scoped invalidation destroys applicability of every certificate which did not causally observe it.

## Current basis-match count

For eligible C:

```text
basisMatchCount(K,C) =
    number of D in currentInputEdges(K) such that
        basisValue(C,D) == valueId(D)
```

`"unknown"` contributes no match.

## Certificate selection

Journal 3 retains all certificates, so it may preserve the strongest sound partial proof available after histories converge.

Choose exactly one certificate:

```text
certificate(K) = eligible C maximizing lexicographically:
    1. basisMatchCount(K,C)
    2. authorityCompare(C, ...)
```

If there is no eligible certificate, K has no current certificate.

This deliberately differs from Journal 2's compaction-oriented “greatest certificate only” rule. Journal 3 does not need to discard a better-matching concurrent historical proof merely so lower certificates can be compacted away.

Authority is the deterministic tie-break among equally applicable certificates.

Replay never synthesizes a certificate by combining basis entries from different validations.

For ordinary single-writer evolution, the latest successful validation normally has the complete current input basis and therefore wins naturally.

## Incoming validity edge

For current structural edge `D -> K`:

```text
edgeValid(D,K) iff
    present(D)
    and present(K)
    and certificate(K) exists
    and basisValue(certificate(K), D) == valueId(D)
```

A value-scoped invalidation does not by itself remove incoming validity proof. This preserves the existing distinction between proof validity and persistent stale freshness.

The legacy inverse relation is:

```text
nodeIdentifier(K) in valid[nodeIdentifier(D)]
    iff edgeValid(D,K)
```

All validity edges for K come from one selected certificate.

## Freshness

Freshness is derived recursively over the current schema DAG.

For present K:

```text
fresh(K) iff
    certificate(K) exists
    and basisMatchCount(K, certificate(K))
        == currentInputEdges(K).length
    and not uncoveredValueInvalidation(K, certificate(K))
    and for every D in currentInputEdges(K):
        present(D)
        and fresh(D)
```

For a zero-input node, the full-basis/input condition is vacuous; it still requires an eligible certificate and no uncovered current-value invalidation.

The legacy freshness projection is:

```text
freshness[nodeIdentifier(K)] = "up-to-date"
    iff fresh(K)

freshness[nodeIdentifier(K)] = "potentially-outdated"
    iff present(K) and not fresh(K)
```

## Persistent propagated staleness

The existing flag-based algorithm requires propagated stale state to persist even if an upstream node later revalidates unchanged.

Journal 3 records that transition using a value-scoped InvalidateEvent for the affected cached occurrence.

Therefore replay does not make a stale dependent fresh merely because all its inputs later become fresh again. The dependent itself needs a causally later validation covering its stale marker.

Ordinary emission and synchronization normalization must author these events whenever the existing graph semantics create such a persistent fresh-to-stale transition.

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

and there are no other entries.

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

The semantic timestamp is the exact instant carried by the selected ValueEvent; replay does not substitute current synchronization/replay time.

### freshness

Write the freshness state derived above for every present K.

### valid

For every current structural edge D -> K, include K's selected identifier in `valid[D]` exactly when `edgeValid(D,K)`.

No validity entry may mention an absent/losing identifier.

### graph_scheme / structural dependency relation

Structural dependencies are derived from the current application/schema interpretation exactly as in the existing graph design.

The persisted current `graph_scheme` representation is the lowering of that current schema/version contract. Journal history does not treat mutable `graph_scheme` bytes as conflict authority.

Schema migration is responsible for creating a new current baseline compatible with the target schema before that target becomes active.

## Host-local allocation watermark

For local writer A:

```text
WriterState(A) = all WriterStateRecords authored by A
```

If none exist, replay uses the defined initial local `last_node_index` (currently zero).

Otherwise:

```text
last_node_index =
    lastNodeIndex from the greatest A-local WriterStateRecord by sequence
```

WriterState values must be monotone nondecreasing.

Foreign writer-state records do not change this database's local watermark.

## Replay equality

Two current projections are semantically equivalent when they agree on:

- current present semantic NodeKeys;
- selected ValueId for every present node;
- exact payload;
- createdAt/modifiedAt instants;
- selected NodeIdentifier;
- freshness;
- semantic validity edges;
- local writer last_node_index when comparing the same local-writer projection; and
- current schema-derived structural representation required by the existing graph storage contract.

Temporary paths, inactive replica-slot names, transport metadata, LevelDB internal sequence numbers, and derived Journal index layouts are excluded.

## Replay algorithms

The definitions above are declarative.

A conforming implementation may use:

- whole-history reference replay;
- incremental folding;
- per-node current-head/certificate indexes;
- verified replay checkpoints;
- another algorithm proven observationally equivalent.

Record arrival order must not change the final result for one final supported journal.

A clear whole-history/reference path should remain available as an implementation/test oracle even if production projection is incremental.

## Replay checkpoint correctness

A checkpoint names an exact JournalFrontier F and contains derived state equivalent to replaying history through F under the compatible schema interpretation for that checkpoint.

It is usable only when:

```text
checkpointProjection == project(journal through F)
```

and later replay consumes immutable suffix history from the same writer streams.

Checkpoint loss is harmless to authority. Authoritative record loss is not.

## Corruption/inconsistency handling

Replay/import rejects rather than guesses when it encounters, among other things:

- a writer-stream hole;
- conflicting canonical meaning for one JournalRecordId;
- undecodable/unsupported record version;
- an event whose claimed causal context is not retained;
- a ValueId reference which is not causally prior to the referencing event;
- a validation target naming a non-ValueEvent or another semantic node;
- duplicate input NodeKeys in one validation basis;
- a known basis ValueId whose ValueEvent node differs from the entry's explicit input NodeKey;
- illegal `"unknown"` use by an ordinary validation;
- a final selected-head set which is not dependency-closed;
- malformed timestamps;
- incompatible current reuse of one NodeIdentifier;
- decreasing same-writer allocation watermark;
- a persisted current graph known to disagree with replay.

Payload equality is never a repair mechanism for journal identity, reference, or provenance conflicts.
