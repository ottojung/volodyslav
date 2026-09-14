# IncrementalGraph Journal 3 Replay and Projection

## Purpose

This document defines the deterministic projection from a supported causally closed Journal 3 history into the existing persisted IncrementalGraph representation.

The journal is authoritative. The legacy graph sublevels are a materialized view.

The projection is defined semantically over immutable journal history. An implementation may maintain equivalent indexes incrementally and is not required to rescan all retained history after every operation.

## Inputs to replay

Core replay operates under one exact compatible database version and graph schema and takes:

```text
replay(
    journal: JournalReplica,
    localWriter: JournalAuthor,
    graphSchema
)
```

The `localWriter` identifies the database whose host-local allocator projection is being reconstructed. It does not affect semantic conflict selection.

Before replay, the journal must satisfy the stream-identity, prefix-contiguity, immutable-record, timestamp, and causal-closure invariants in `incremental-graph-journal-types.md`.

## Semantic history of one node

For semantic `NodeKey K`, define:

```text
History(K) = all SemanticEvent records whose node == K
```

Journal 3 retains this complete history. Projection does not require a compacted `NodeJournalSummary` to stand in for discarded events.

## Semantic head

Let:

```text
HeadCandidates(K) =
    ValueEvents(K) union DeleteEvents(K)
```

If `HeadCandidates(K)` is empty, K has no semantic head and is absent.

Otherwise:

```text
head(K) = greatest event in HeadCandidates(K) by authorityCompare
```

If `head(K)` is a `DeleteEvent`, K is absent.

If `head(K)` is a `ValueEvent`, K has a present semantic head. Its event ID is the current `ValueId(K)` and it supplies the candidate current payload, timestamps, and physical `NodeIdentifier`.

A losing value event remains historical and inspectable but supplies no current graph payload merely because its payload compares equal to the winner.

## Dependency closure is a supported-state condition

The existing IncrementalGraph requires materialized nodes to be dependency-closed.

Journal 3 therefore requires the selected semantic heads of every supported committed projection to satisfy:

```text
head(K) is ValueEvent
    => for every D in inputEdges(K): head(D) is ValueEvent
```

A raw union of two valid journals may temporarily violate this condition while synchronization is constructing an inactive target. Such a union is not yet a publishable graph projection.

Before cutover, synchronization must normalize the journal by authoring whatever causally-later `DeleteEvent`/other semantic events are required by the synchronization specification so that the final selected heads are dependency-closed.

Journal 3 deliberately does not hide a selected value merely because an input is absent while keeping that value as a latent current cache outside the legacy graph. Doing so could later rematerialize a value which the ordinary IncrementalGraph would have structurally removed and would weaken the existing `oldValue` contract. Structural removal is represented explicitly in journal history.

After normalization, define:

```text
present(K) iff head(K) is ValueEvent
```

and dependency closure guarantees that every input of a present node is also present.

## Selected value occurrence

When `present(K)` holds, let:

```text
V(K) = head(K) as ValueEvent
```

The projected current occurrence is exactly:

```text
valueId(K)        = V(K).id
payload(K)        = V(K).payload
nodeIdentifier(K) = V(K).nodeIdentifier
createdAt(K)      = V(K).createdAt
modifiedAt(K)     = V(K).modifiedAt
```

Replay does not obtain any of these fields from the current legacy graph.

If two present semantic nodes select the same `NodeIdentifier`, replay rejects the journal as unsupported/corrupt. The physical identifier map must remain bijective.

## Invalidation coverage

For semantic events I and C:

```text
coveredBy(I,C) iff happenedBefore(I,C)
```

A validation does not clear a concurrent invalidation merely because its `authorityTime` happens to compare greater. Clearing is causal, not last-writer-wins.

For present K and validation C, define:

```text
uncoveredNodeInvalidation(K,C) iff
    exists InvalidateEvent I in History(K) such that
        I.scope.kind == "node"
        and not coveredBy(I,C)
```

For present K with current value V and validation C, define:

```text
uncoveredValueInvalidation(K,V,C) iff
    exists InvalidateEvent I in History(K) such that
        I.scope.kind == "value"
        and I.scope.value == V.id
        and not coveredBy(I,C)
```

Node-scoped invalidations remain relevant across value changes until a later validation causally observes them. Value-scoped invalidations apply only to their named value occurrence.

Invalidations scoped to losing historical ValueIds remain part of replay/debug history but do not directly stale the current different value occurrence.

## Validation candidates

For present K, define:

```text
Validations(K) = {
    C | C is ValidateEvent
        and C.node == K
        and C.value == valueId(K)
}
```

A validation is structurally well formed only when its basis length equals `inputEdges(K).length` and every non-`"unknown"` basis entry names a retained `ValueEvent` for the corresponding semantic input node.

A validation whose basis contains a non-unknown `ValueId` belonging to another semantic input is corrupt rather than merely inapplicable.

A certificate is eligible only when it clears every node-scoped invalidation represented for K:

```text
eligibleCertificate(K,C) iff
    C in Validations(K)
    and not uncoveredNodeInvalidation(K,C)
```

For eligible C, define its current basis-match count:

```text
basisMatchCount(K,C) =
    number of direct input positions i such that
        C.basis[i] == valueId(inputEdges(K)[i])
```

`"unknown"` contributes no match.

Journal 3 selects one current certificate, so the legacy incoming proof relation is never synthesized by mixing incompatible basis edges from separate historical validations.

Choose:

```text
certificate(K) = eligible C maximizing, lexicographically:
    1. basisMatchCount(K,C)
    2. authorityCompare(C, ...)
```

If no eligible certificate exists, K has no current certificate.

This uses retained history more precisely than simply taking the newest/highest-authority validation. A concurrent validation against a losing input history must not erase an older sound proof which matches more of the final selected input occurrences. Authority remains the deterministic tie-break between equally applicable proofs.

For ordinary single-host evolution, the most recent successful validation normally has a complete current basis and therefore remains the selected certificate.

## Incoming validity edge

Let:

```text
inputEdges(K) = [D0, D1, ...]
```

For current present nodes `Di` and K, the legacy validity edge `Di -> K` exists exactly when:

```text
edgeValid(Di,K) iff
    present(K)
    and present(Di)
    and certificate(K) exists
    and certificate(K).basis[i] == valueId(Di)
```

`"unknown"` never equals a current `ValueId`, so it reproduces an absent incoming proof.

A value-scoped invalidation does not by itself remove incoming validity proof. This preserves the existing flag-based distinction between proof invalidation and freshness-only staleness.

The projected legacy inverse relation is:

```text
K_identifier in valid[D_identifier]
    iff edgeValid(D,K)
```

where identifiers are the selected current `nodeIdentifier` values.

Because all edges come from one selected certificate, complete incoming validity implies that one historical validation actually certified the current complete direct-input value vector. Replay never fabricates a multi-input proof by combining separate certificates.

## Freshness

Freshness is recursively derived over the fixed schema DAG.

For present K:

```text
fresh(K) iff
    certificate(K) exists
    and basisMatchCount(K, certificate(K)) == inputEdges(K).length
    and not uncoveredValueInvalidation(
        K,
        V(K),
        certificate(K)
    )
    and for every direct input Di:
        present(Di)
        and fresh(Di)
```

For zero-input nodes, the full-basis condition is vacuously satisfied. They still require an eligible certificate which causally covers all applicable invalidation history.

The legacy freshness projection is:

```text
freshness[nodeIdentifier(K)] = "up-to-date"
    iff fresh(K)

freshness[nodeIdentifier(K)] = "potentially-outdated"
    iff present(K) and not fresh(K)
```

## Persistent propagated staleness

The existing IncrementalGraph algorithm distinguishes explicit invalidation from propagated staleness. A propagated stale transition may need to persist even if the upstream node later revalidates without changing value.

Journal 3 represents such a transition with a value-scoped `InvalidateEvent` for the affected cached value occurrence. Therefore replay does not infer or forget propagated staleness merely from the current freshness of inputs.

Emission rules for local pull/invalidate operations and synchronization normalization must author the required value-scoped invalidations whenever the existing IncrementalGraph semantics create such persistent stale state.

This is a historical advantage of replay: the stale transition itself remains visible instead of being collapsed into a current boolean whose provenance is lost.

## Legacy sublevel projection

Let:

```text
PresentKeys = { K | present(K) }
```

Replay lowers semantic state into the unchanged legacy storage as follows.

### identifiers_keys_map

For every K in `PresentKeys`:

```text
identifiers_keys_map[nodeIdentifier(K)] = K
```

There are no other entries.

The mapping must be bijective.

### values

For every K in `PresentKeys`:

```text
values[nodeIdentifier(K)] = payload(K)
```

There are no values for absent keys.

### timestamps

For every K in `PresentKeys`:

```text
timestamps[nodeIdentifier(K)] = {
    createdAt: serializeCanonical(createdAt(K)),
    modifiedAt: serializeCanonical(modifiedAt(K))
}
```

The textual serialization may use the project's canonical supported timestamp spelling; replay meaning is the exact instant carried by the selected `ValueEvent`.

### freshness

For every K in `PresentKeys`, write the freshness value defined above.

### valid

For every current present structural edge `D -> K`, include K's current identifier in `valid[D]` exactly when `edgeValid(D,K)` holds.

No validity edge may mention an absent or losing physical identifier.

### structural dependency relation

There is no persisted per-node input list. As in the existing graph design, structural dependencies are derived from the fixed `graph_scheme`, semantic NodeKeys, and the identifier lookup.

## Host-local allocation watermark

For local writer A, define:

```text
WriterState(A) = all WriterStateRecord records authored by A
```

If none exist, the replayed `last_node_index` is zero.

Otherwise:

```text
last_node_index =
    WriterStateRecord with greatest A-local sequence .lastNodeIndex
```

The record values must be monotone; replay rejects a decreasing local watermark.

Foreign writers' watermark records do not change this database's `last_node_index`.

Because `NodeIdentifier` allocation itself is represented by the identifiers carried in historical value occurrences while the watermark is recorded explicitly, replay can reconstruct both current identifier mapping and local allocation safety without trusting current mutable allocator metadata.

## Replay equality

Two replay results are semantically equivalent when they agree on:

- present semantic NodeKeys;
- selected `ValueId` for every present node;
- exact payloads;
- `createdAt` and `modifiedAt` instants;
- freshness;
- validity edges by semantic NodeKey;
- selected current physical `NodeIdentifier`s;
- local writer `last_node_index` when comparing the same local writer projection.

Temporary storage paths, inactive replica names, LevelDB internal sequence numbers, and transport metadata are excluded.

## Replay algorithms

The normative projection above is declarative. Implementations may realize it by:

- replaying records from an empty projection;
- incrementally folding newly appended/imported records;
- maintaining per-node indexes;
- loading a verified checkpoint and replaying the suffix; or
- another algorithm proven observationally equivalent.

An implementation must not change semantics merely because records arrived in a different network order. It must wait for causal closure, complete any required synchronization normalization, and compute the same result for the same final retained journal.

## Replay checkpoint correctness

A replay checkpoint names an exact journal frontier F and contains a derived projection equivalent to replaying the journal through F.

Using a checkpoint is correct only when:

```text
checkpointProjection == project(journal through F)
```

and all replay after F consumes immutable records from the same writer histories.

A checkpoint may be regenerated or discarded. It carries no semantic authority beyond the journal records it summarizes.

## Corruption/inconsistency handling

Replay rejects rather than guesses when it encounters, among other things:

- a writer-stream hole;
- conflicting content for one `JournalRecordId`;
- an event whose causal context is not retained;
- a `ValidateEvent` targeting a non-ValueEvent ID;
- a validation basis with wrong arity or a non-unknown entry naming the wrong semantic input;
- a final selected-head set which is not dependency-closed;
- malformed timestamps;
- incompatible reuse of one `NodeIdentifier`;
- decreasing same-writer allocation watermark;
- a legacy persisted graph which disagrees with the journal projection at a boundary where graph/journal consistency is being validated.

Payload equality is never a repair mechanism for journal identity or provenance conflicts.
