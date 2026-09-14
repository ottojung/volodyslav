# IncrementalGraph Journal 3 Event Emission

## Purpose

This document maps ordinary IncrementalGraph transitions to replay-complete Journal 3 records.

The existing public `pull()` and `invalidate()` semantics remain defined by the IncrementalGraph specifications. Journal 3 does not change what those operations mean. It records enough immutable low-level history that replay reconstructs the same persisted value, timestamps, freshness, and validity state.

All graph writes and journal records belonging to one committed transition are published atomically.

## General rule

For every supported graph transition from persisted state `G` to `G'`, the operation must append records `R` such that:

```text
project(journal + R) == G'
```

under the same schema/version interpretation.

A mutation path must not change persisted semantic graph state in a way which has no replay explanation in the journal.

Conversely, it must not append semantic journal events describing a graph transition which did not commit.

## Event allocation

Before allocating semantic events, the operation uses the then-current retained journal frontier as causal knowledge and the maximum observed semantic `AuthorityTime` as the HLC high-water state.

Records authored by one operation receive consecutive local writer-stream sequences in a deterministic topological order extending semantic happened-before constraints.

At minimum:

- a `ValueEvent` precedes the `ValidateEvent` which names its new `ValueId`;
- a root value change or explicit invalidation precedes propagated invalidations caused by that transition;
- a destructive event for a dependency precedes a destructive event authored for a dependent solely because dependency closure requires it.

## Successful pull: new materialization

Suppose pulling K materializes a previously absent node and its computor returns payload P.

After its inputs have been successfully pulled and their current Journal 3 `ValueId`s are known, publication:

1. allocates the ordinary new `NodeIdentifier` for K;
2. determines the ordinary legacy timestamp record `{createdAt, modifiedAt}` for the new materialization;
3. authors:

```text
ValueEvent {
    node: K,
    nodeIdentifier,
    payload: P,
    createdAt,
    modifiedAt,
    reason: "compute"
}
```

4. uses that event's ID as the new `ValueId(K)`;
5. authors a `ValidateEvent(reason="compute")` for that `ValueId` whose basis contains the current `ValueId` of every direct semantic input in `inputEdges(K)`;
6. projects K as fresh with complete incoming validity;
7. records any required writer allocation-watermark advance with a `WriterStateRecord` in the same publication.

No journal lookup or payload equality can substitute for recording P: the new value event is the replay source for the payload.

## Successful pull: changed existing value

Suppose K is already materialized and the computor returns a semantic value different from the stored current value according to the ordinary IncrementalGraph equality rule.

Publication:

1. preserves K's current physical `NodeIdentifier`;
2. preserves the materialization lineage's existing `createdAt`;
3. obtains the ordinary new `modifiedAt` for the changed semantic value;
4. authors a new `ValueEvent(reason="compute")` containing the new payload, preserved identifier/creation time, and new modification time;
5. uses its event ID as the new `ValueId(K)`;
6. authors a new `ValidateEvent(reason="compute")` with the exact current direct-input `ValueId` basis;
7. authors the value-scoped propagated invalidation events described below for every dependent whose persistent freshness transition is caused by the value change.

The old value occurrence remains permanently present in journal history. It simply ceases to be the selected head when the new value event has greater authority.

## Successful pull: unchanged computor result

When a stale node's computor returns `Unchanged`:

- preserve the current `ValueId`;
- preserve its `ValueEvent` payload, `NodeIdentifier`, `createdAt`, and `modifiedAt`;
- author a new `ValidateEvent(reason="unchanged")` targeting that same `ValueId`;
- record the exact current direct-input `ValueId`s in its basis;
- do not author a `ValueEvent`.

Replay therefore reconstructs the same cached value with a later validation certificate.

## Cache revalidation without computor invocation

When a stale non-zero-input node has complete current incoming validity and the ordinary pull algorithm cache-revalidates it without invoking its computor:

- preserve the current `ValueId` and all value/timestamp fields;
- author `ValidateEvent(reason="cache-revalidate")` targeting the current value;
- use the exact current direct-input `ValueId` basis;
- do not author a `ValueEvent`.

The validation event is required because freshness changes from stale to fresh and replay must be able to explain that transition.

## Fresh fast path

A pull which returns an already-up-to-date cached node without changing any persisted graph fact authors no semantic event.

Journal 3 records state transitions, not every API call.

High-level operation tracing may later record such calls as non-semantic history without affecting replay.

## Explicit invalidation

Explicit `invalidate(K)` of a currently materialized node authors:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "node" },
    reason: "explicit"
}
```

This event removes replay validity of K's incoming proof until a later validation causally observes the invalidation.

The root node retains its current value occurrence and outgoing proof history.

If K is unmaterialized and the ordinary graph operation is a no-op, no invalidation event is required.

## Propagated staleness

The existing flag-based algorithm propagates stale freshness through the current outgoing `valid` frontier while preserving those validity edges.

For every materialized dependent D whose persisted freshness actually transitions from `"up-to-date"` to `"potentially-outdated"` because of a local value change or invalidation propagation, author:

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

Do not author another propagated invalidation merely because traversal reaches a node which was already stale before this transition.

These records are what make propagated staleness replayable after the upstream node later revalidates unchanged. Without them, current booleans could not be reconstructed exactly from history.

## Why propagated invalidation targets a ValueId

Propagated staleness belongs to the dependent's current cached occurrence.

If D later changes to a genuinely new `ValueId`, the old propagated invalidation does not stale that new occurrence. A later validation of the old occurrence can causally cover and clear the invalidation if the old occurrence is still current.

This is why propagated invalidation is value-scoped rather than node-scoped.

## Deletion

Ordinary `pull()`/`invalidate()` do not normally delete materialized nodes, but lifecycle operations and synchronization normalization may need to.

A semantic removal authors:

```text
DeleteEvent {
    node: K,
    reason: ...
}
```

The delete becomes an absence candidate ordered against historical value/delete events by semantic authority.

If deleting K requires structural deletion of materialized dependents to preserve dependency closure, every such dependent removal must receive its own causally ordered `DeleteEvent`. The journal does not infer a silent graph deletion which has no event.

Historical payloads remain available in their old `ValueEvent`s after deletion.

## Synchronization import versus authoring

Importing a foreign journal record does not author a new local event.

If synchronization receives B's `ValueEvent B:73`, the receiver stores B:73 unchanged. No receiver-local adoption event is emitted merely to acknowledge that fact.

If the union of histories cannot be published directly because replay would violate dependency closure or another IncrementalGraph invariant, synchronization may author receiver-local `InvalidateEvent`/`DeleteEvent` records according to the synchronization semantic rules. Those are real new semantic transitions and therefore belong to the receiver's writer stream.

## Physical identifier and allocator recording

A `ValueEvent` carries the exact `NodeIdentifier` of its value occurrence.

When a local publication advances the persisted `last_node_index` allocation watermark, the same journal publication records the resulting host-local watermark in a `WriterStateRecord`.

This remains required even if some retired allocation indices correspond to failed/unmaterialized attempts, because replay must reconstruct allocator safety rather than infer the watermark only from currently selected node identifiers.

A foreign `WriterStateRecord` never advances the local writer's watermark.

## No payload equality as provenance

If two independently authored values are deeply equal, they remain two distinct `ValueId`s.

Equality may determine whether a local computor result counts as changed under the ordinary IncrementalGraph operation, but synchronization and replay do not use equality to identify occurrences, merge histories, recover a missing record, or choose conflict authority.

## Atomic publication

One successful graph transition atomically publishes all applicable pieces of:

- new local journal records;
- local writer-stream head/cached frontier updates;
- authority-clock allocator cache updates;
- `identifiers_keys_map` mutations;
- `values` mutations;
- `timestamps` mutations;
- `freshness` mutations;
- `valid` mutations;
- `last_node_index` updates.

The resulting committed legacy graph must equal the replay projection of the resulting committed journal.

If the durable publication fails, neither side of that transition may be exposed as committed supported state.

## Bootstrap and migration boundary

Creating Journal 3 from a pre-Journal-3 persisted graph is a migration problem rather than an ordinary local event-emission case.

That migration must construct replay history which projects exactly to the pre-migration semantic graph state while preserving the relevant synchronization meaning available from that legacy state. In particular, legacy stale nodes may require `"unknown"` basis entries and explicit bootstrap invalidation events to reproduce partial validity/freshness without inventing provenance.

The complete bootstrap algorithm belongs to the Journal-3-aware migration specification.
