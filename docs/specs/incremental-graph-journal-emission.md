# IncrementalGraph Journal 3 Event Emission

## Purpose

This document maps ordinary IncrementalGraph transitions to replay-complete Journal 3 records.

It covers normal runtime graph operations, not synchronization/reset/bootstrap/migration maintenance.

## Emission principle

For an ordinary committed graph transition:

```text
Gbefore -> Gafter
```

emission appends exactly the semantic history needed so that:

```text
project(Jafter) == Gafter
```

A public call which produces no persisted semantic graph change need not append a semantic event merely because it was invoked.

## Staging versus finalization

Computation may stage intents, but durable event IDs/contexts/authority are not reserved until serialized publication finalization.

This matters because the final committed graph/input state may differ from the state seen when computation began within the limits allowed by the existing graph locking model.

At finalization:

1. read latest committed local writer head/frontier/high-water;
2. determine the actual settled graph transition;
3. drop/add staged effects to match that transition exactly;
4. allocate a contiguous local writer range;
5. resolve same-publication ValueIds in semantic dependency order;
6. assign every semantic event `(W,q)`:

```text
context[W] = q - 1
```

and the complete observed causally closed cross-writer frontier;
7. allocate AuthorityTimes extending all causal predecessors;
8. atomically publish graph + Journal records.

Failed transactions consume no durable sequence positions.

## Contexts record complete observation

An event context is never merely the set of writers explicitly referenced by its body.

If the operation observed B:7 and B:7 had observed A:11, the new event context includes A through at least 11 even when the new event body directly references only B.

All ordinary emission therefore preserves transitive `happenedBefore`.

## Fresh pull fast path

If K is already fresh and pull performs no persisted graph transition:

```text
no semantic Journal record required
```

Reading/returning a cached value is not itself historical mutation.

## First materialization / changed recomputation

If K becomes a new semantic value occurrence, emit one `ValueEvent` carrying the exact committed:

- NodeKey;
- NodeIdentifier;
- ComputedValue payload;
- createdAt;
- modifiedAt.

Its event ID becomes the new `ValueId(K)`.

Then emit one `ValidateEvent` for that ValueId whose explicit basis contains exactly one entry for each current direct input D:

```text
{ input: D, value: finalCurrentValueId(D) }
```

in canonical persisted NodeKeyString order.

A normal compute validation never uses `"unknown"`.

The ValueEvent precedes the ValidateEvent in the same publication.

## `Unchanged`

If K's computor returns `Unchanged`, preserve the existing current ValueId.

If K was stale and the operation successfully revalidates it, emit one `ValidateEvent` targeting that existing ValueId with the finalized current input basis.

Do **not** emit another ValueEvent merely because a validation happened.

The validation causally covers prior node/value invalidations only when those invalidations are in its closed context.

## Cache revalidation

When existing graph semantics revalidate a cached occurrence without recomputing/replacing its payload, preserve its ValueId and append the required ValidateEvent exactly as for `Unchanged`.

Proof state and value occurrence identity are separate.

## Explicit invalidation

For explicit invalidation of K, emit:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "node" },
    reason: "explicit"
}
```

A later validation clears this node-scoped invalidation only by causally observing it.

## Propagated fresh-to-stale transition

When ordinary graph semantics actually propagate fresh->stale to cached dependent D without deleting its occurrence, emit:

```text
InvalidateEvent {
    node: D,
    scope: {
        kind: "value",
        value: currentValueId(D)
    },
    reason: "propagated"
}
```

Only dependents which undergo the persistent flag transition receive such events.

A value-scoped invalidation does not by itself erase D's incoming validity edges; it keeps that exact cached occurrence stale until D itself validates/recomputes.

## Materialization deletion

When ordinary graph semantics remove K's cached materialization, emit:

```text
DeleteEvent {
    node: K,
    reason: "operation"
}
```

If one deletion structurally requires removal of dependent materializations, emit the complete actual deletion closure in cause-before-dependent order.

Old ValueEvents remain retained history.

## Value change plus dependent invalidation

A changed recomputation may publish:

```text
Value(K,new)
Validate(K,new,basis)
Invalidate(D1,currentD1,propagated)
Invalidate(D2,currentD2,propagated)
...
```

The K value/validation precede propagated effects they cause where causality requires it. Dependent invalidations use their own final current ValueIds.

## WriterStateRecord emission

When ordinary publication durably advances local `last_node_index`, include a WriterStateRecord sufficient for replay to reconstruct the resulting watermark.

The watermark is monotone and never decreases/reuses retired indices.

If no durable allocator advancement occurred, no redundant WriterStateRecord is required merely because a transaction executed.

## Publication ordering

One publication chooses a deterministic order extending all semantic constraints:

- referenced same-publication ValueEvent before referencing Validate/Invalidate event;
- direct cause before propagated dependent effect;
- dependency deletion before dependent deletion;
- WriterState placement deterministic and replay-safe.

When no semantic order exists, canonical NodeKey then stable record-kind order is an acceptable tie-break.

## Validation basis finalization

A computor may run before final darkroom publication, but the persisted basis is constructed/confirmed from the **actual final current input ValueIds at commit** under the existing graph locking guarantees.

If the staged computation result can no longer legitimately be committed against those final inputs, the graph transaction semantics must reject/retry/recompute as appropriate; Journal emission never lies by recording a basis the committed computation did not establish.

## Atomicity

The graph transition and all finalized Journal records become durable together.

No supported observation sees only one side.

## No payload equality inference

Emission never searches history for an equal payload to reuse an unrelated ValueId.

ValueId preservation happens only when the graph operation semantically preserves the current occurrence (`Unchanged`/cache revalidation), not because bytes happen to compare equal.

## Maintenance boundary

Synchronization, reset, bootstrap, and migration have separate authoring rules because they operate over retained histories/source targets rather than ordinary computor transitions.

Those maintenance rules decide whether a semantic value occurrence is preserved or replaced. In particular, reset/migration do not create a new ValueEvent merely because proof, freshness, schema, database version, or stored representation changes; semantic-preserving migration `override()` keeps the existing ValueId through target-format representation rewrite. A maintenance ValueEvent is authored only when the corresponding lifecycle rule genuinely creates/replaces the semantic occurrence.

Maintenance still obeys the same core event rules:

- immutable writer identity;
- contiguous sequences;
- closed event contexts;
- causality-respecting authority;
- reference causality;
- atomic Journal/projection publication.