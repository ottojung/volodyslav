# IncrementalGraph Journal 3 Event Emission

## Purpose

This document maps ordinary IncrementalGraph transitions to replay-complete Journal records. Synchronization, reset, bootstrap, recovery, and migration have separate maintenance rules.

## Emission law

For every successful ordinary committed graph transition:

```text
project(Jafter) == Gafter
```

An API call which produces no persisted semantic graph change need not append a semantic record merely because it ran.

## Staging and serialized finalization

Computors may run before final publication and may stage semantic intents. Durable Journal coordinates are allocated only inside the serialized graph finalization boundary.

Finalization:

1. reads the latest committed local writer head/frontier and authority high-water;
2. determines the actual settled graph transition;
3. drops staged effects which did not happen and adds effects discovered during reconciliation;
4. constructs validation bases from the final current direct-input ValueIds;
5. allocates one contiguous local writer range;
6. resolves same-publication ValueId references in semantic dependency order;
7. gives semantic `(W,q)` exact own-writer context `q-1` plus the complete causally closed foreign frontier semantically observed;
8. allocates authority extending every predecessor; and
9. atomically publishes graph + Journal records.

Failed transactions consume no durable sequence coordinate.

## Contexts are complete semantic observation

If ordinary publication observes B:7 and B:7 observed A:11, the new context includes A through at least 11 even when its body references only B.

The narrow pre-Journal historical-value conversion exception is lifecycle-only; ordinary emission cannot omit observed ancestry.

## Fresh pull no-op

If K is already fresh and pull changes no persisted state:

```text
no semantic Journal record
```

Reading a cached value is not historical mutation.

## First materialization or changed recomputation

When K becomes a new semantic value occurrence, emit:

1. `ValueEvent` containing the exact committed NodeKey, NodeIdentifier, payload, `createdAt`, and `modifiedAt`;
2. `ValidateEvent` targeting that new ValueId with one canonical-order basis entry per current direct input:

```text
{ input: D, value: finalCurrentValueId(D) }
```

Normal compute validation never uses `"unknown"`.

The ValueEvent precedes references to it.

## `Unchanged` and cache revalidation

When K's semantic value occurrence is preserved, keep its existing ValueId. If the operation revalidates it, emit a new ValidateEvent for that ValueId with the finalized current input basis.

Proof state is not value-occurrence identity.

## Explicit invalidation

Explicit invalidation of K emits:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "node" },
    reason: "explicit"
}
```

A validation clears its effect only by causally observing it.

## Propagated persistent staleness

When ordinary graph semantics persist a fresh -> stale flag transition on cached dependent D without deleting D, emit:

```text
InvalidateEvent {
    node: D,
    scope: { kind: "value", value: currentValueId(D) },
    reason: "propagated"
}
```

This does not directly remove D's incoming proof. It keeps that exact occurrence stale until D itself validates/recomputes.

## Deletion

When ordinary graph semantics remove K's materialization, emit:

```text
DeleteEvent {
    node: K,
    reason: "operation"
}
```

If structural closure requires deleting dependents, emit the complete actual closure cause-before-dependent. Historical values remain retained.

## Writer state

Whenever ordinary publication durably advances local `last_node_index`, include a WriterStateRecord sufficient for replay to reconstruct the resulting nondecreasing watermark. No redundant writer-state record is required when allocation did not advance.

## Publication order

One publication uses a deterministic order extending semantic dependencies:

- referenced ValueEvent before its references;
- cause before propagated stale effect;
- input/structural deletion before dependent deletion;
- deterministic WriterState placement.

Canonical NodeKey and stable record-kind order may break otherwise-unconstrained ties.

## Validation basis finalization

The persisted validation basis describes the **actual committed** computation/proof. If a staged computation can no longer legitimately commit against final direct-input ValueIds, the graph operation must retry/recompute/fail according to existing transaction semantics; Journal emission must not record a false basis.

## Atomicity and allocator safety

Graph mutation, Journal records, writer head/watermark, and required derived state become durable together. Volatile allocator/index state must not outrun durable success.

## No payload-equality identity inference

Emission never searches history for equal payload bytes to reuse an unrelated ValueId. ValueId is preserved only when the graph semantics preserve the existing occurrence.

## Maintenance boundary

Maintenance transitions also separate value identity from proof/freshness state:

- reset preserves a ValueId when the requested occurrence already exists;
- bootstrap may establish/reuse historical occurrence identities under its special legacy rules;
- Journal-aware migration preserves ValueId for occurrence-preserving semantic decisions such as `keep` and `invalidate`;
- representation-only Journal format change is performed by the canonical whole-history codec while selected preserved state uses `keep`; Journal-aware code does **not** evaluate the legacy value-producing `override()` path;
- maintenance-only proof weakening uses `proof(V,D)` negative edge evidence rather than creating a new ValueEvent; and
- persistent stale state uses `value(V)` invalidation.

A maintenance ValueEvent is authored only when that lifecycle rule genuinely creates/replaces the semantic occurrence.

All maintenance still obeys immutable writer identity, sequence contiguity, causal/reference rules, authority extension, and atomic Journal/projection publication, except for the explicitly specified historical bootstrap-value causality rule.
