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

## Stage intents first; allocate records only at finalization

An ordinary graph operation may discover proposed semantic effects while pulling dependencies or running a computor, but it does **not** reserve durable Journal 3 coordinates at that point.

The transaction stages journal intents describing the effects which would need history if they actually commit.

During the existing serialized per-replica finalization/darkroom boundary, the implementation first reconciles the transaction against the latest committed graph state and determines the **actual final persisted transition**.

Only then does it:

1. read the latest committed local writer head/frontier;
2. read/derive the latest observed semantic authority high-water;
3. discard staged intents for effects which no longer actually occur;
4. add any replay records required by fresh-to-stale/other effects discovered only during commit-time reconciliation;
5. allocate one contiguous local writer sequence range;
6. allocate semantic `AuthorityTime`s from the latest finalization high-water;
7. resolve same-publication symbolic references such as a ValidateEvent targeting the ValueEvent being created in that same publication;
8. order the finalized records deterministically; and
9. publish finalized journal records together with the matching graph writes atomically.

Failed/aborted transactions consume no durable Journal 3 sequence position.

Two concurrent successful transactions therefore cannot both allocate the same local sequence. Their journal order follows their serialized publication order.

## Deterministic same-publication order

Finalized records authored by one operation receive consecutive local writer-stream sequences in a deterministic topological order extending semantic happened-before/reference constraints.

At minimum:

- a `ValueEvent` precedes every same-publication `ValidateEvent` which names its new `ValueId`;
- a root value change or explicit invalidation precedes propagated invalidations caused by that transition;
- a destructive event for a dependency precedes a destructive event authored for a dependent solely because dependency closure requires it;
- every persisted ValueId reference names a causally earlier ValueEvent.

When two records are otherwise unordered, use a stable operation-specific tie-breaker such as canonical NodeKey then record kind.

## Canonical validation-basis construction

Whenever ordinary emission authors a `ValidateEvent` for node K, construct its basis from the **finalized current** direct semantic input set:

```text
inputSet(K) = set(inputEdges(K))
```

For every `D in inputSet(K)`, ordinary compute/unchanged/cache-revalidate validation contains exactly:

```text
{
    input: D,
    value: finalizedCurrentValueId(D)
}
```

Ordinary operation certificates never use `"unknown"`.

After constructing all entries, serialize the basis in canonical semantic NodeKey order, independent of schema input enumeration order.

This rule applies identically to first materialization, changed recomputation, `Unchanged`, and cache revalidation.

## Successful pull: new materialization

Suppose pulling K materializes a previously absent node and its computor returns payload P.

After its inputs have been successfully pulled, the transaction stages a new materialization transition. At finalization, if K is still genuinely being materialized, publication:

1. uses the ordinary newly allocated `NodeIdentifier` for K from the graph transaction;
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

4. uses that finalized event ID as the new `ValueId(K)`;
5. authors a same-publication `ValidateEvent(reason="compute")` for that ValueId using the canonical finalized current-input basis defined above;
6. projects K as fresh with complete incoming validity; and
7. records any required local allocation-watermark advance with a `WriterStateRecord` in the same publication.

No journal lookup or payload equality can substitute for recording P: the new ValueEvent is the replay source for the payload.

## Successful pull: changed existing value

Suppose K is already materialized and the computor returns a semantic value different from the stored current value according to the ordinary IncrementalGraph equality rule.

If finalization still commits that changed value transition, publication:

1. preserves K's selected current physical `NodeIdentifier`;
2. preserves the materialization lineage's existing `createdAt`;
3. obtains the ordinary new `modifiedAt` for the changed semantic value;
4. authors a new `ValueEvent(reason="compute")` containing the new payload, preserved identifier/creation time, and new modification time;
5. uses its finalized event ID as the new `ValueId(K)`;
6. authors a new `ValidateEvent(reason="compute")` using the canonical finalized current-input basis; and
7. authors value-scoped propagated invalidation events for every dependent whose persisted freshness actually transitions from fresh to stale because of this committed value change.

The old value occurrence remains permanently present in journal history. It ceases to be the selected head when the new value event has greater authority.

## Successful pull: unchanged computor result

When a stale node's computor returns `Unchanged` and finalization commits the corresponding stale-to-fresh validation transition:

- preserve the current selected `ValueId`;
- preserve its ValueEvent payload, `NodeIdentifier`, `createdAt`, and `modifiedAt`;
- author a new `ValidateEvent(reason="unchanged")` targeting that same ValueId;
- use the canonical finalized current-input basis;
- do not author a ValueEvent.

Replay therefore reconstructs the same cached occurrence with a later validation certificate.

If commit-time reconciliation shows that no persisted transition is actually required, no redundant semantic validation is required merely because the transaction body had staged one.

## Cache revalidation without computor invocation

When a stale non-zero-input node has complete current incoming validity and the ordinary pull algorithm cache-revalidates it without invoking its computor, and finalization commits stale-to-fresh:

- preserve the current ValueId and all value/timestamp fields;
- author `ValidateEvent(reason="cache-revalidate")` targeting the current value;
- use the canonical finalized current-input basis;
- do not author a ValueEvent.

The validation event is required when freshness actually changes from stale to fresh because replay must explain that transition.

## Fresh fast path

A pull which returns an already-up-to-date cached node without changing any persisted graph fact authors no semantic event.

Journal 3 records semantic state transitions, not every API call.

High-level operation tracing may later record such calls as non-semantic history without affecting replay.

## Explicit invalidation

When finalization commits explicit `invalidate(K)` of a currently materialized node, author:

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

If K was already explicitly/directly invalidated in a way that means this call makes no further persisted semantic transition, a redundant semantic event is not required merely to count the call.

## Propagated staleness

The existing flag-based algorithm propagates stale freshness through the current outgoing `valid` frontier while preserving those validity edges.

For every materialized dependent D whose persisted freshness **actually commits a transition** from `"up-to-date"` to `"potentially-outdated"` because of a local value change or invalidation propagation, author:

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

Do not author another propagated invalidation merely because traversal reaches a node which was already stale before the committed transition.

The final transition is evaluated after commit-time reconciliation, so concurrent activity cannot cause the journal to claim a fresh-to-stale transition which did not actually occur.

These records make propagated staleness replayable after the upstream node later revalidates unchanged. Without them, current freshness could not be reconstructed exactly from history.

## Why propagated invalidation targets a ValueId

Propagated staleness belongs to the dependent's current cached occurrence.

If D later changes to a genuinely new `ValueId`, the old propagated invalidation does not stale the new occurrence.

A later validation of the same old occurrence can causally cover/clear that invalidation if that occurrence is still current.

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

If deleting K requires structural deletion of materialized dependents to preserve dependency closure, every such dependent removal receives its own causally ordered `DeleteEvent`. The journal does not infer a silent graph deletion which has no event.

Historical payloads remain available in old ValueEvents after deletion.

## Synchronization import versus authoring

Importing a foreign journal record does not author a new local event.

If synchronization receives B's `ValueEvent B:73`, the receiver retains B:73 unchanged. No receiver-local adoption event is emitted merely to acknowledge that fact.

If unioned history cannot be published directly because current IncrementalGraph semantics require dependency-closure deletion or persistent receiver-side staleness, synchronization authors only the normalization events defined by `incremental-graph-journal-sync.md`. Those are genuine new receiver semantic transitions.

## Physical identifier and allocator recording

A `ValueEvent` carries the exact `NodeIdentifier` of its value occurrence.

When a successful local publication advances the persisted `last_node_index` allocation watermark, the same journal publication records the resulting host-local watermark in a `WriterStateRecord`.

This remains required even if retired allocation indices include gaps caused by failed/unmaterialized attempts: replay must reconstruct allocator safety rather than infer the watermark only from currently selected node identifiers.

A foreign `WriterStateRecord` never advances another writer's local watermark.

## No payload equality as provenance

If two independently authored values are deeply equal, they remain two distinct ValueIds.

Equality may determine whether a local computor result counts as changed under the ordinary IncrementalGraph operation, but synchronization/replay do not use equality to identify occurrences, merge histories, repair references, or choose conflict authority.

## Atomic publication

One successful graph transition atomically publishes all applicable pieces of:

- finalized new local journal records;
- matching legacy graph mutations;
- local writer head/frontier caches;
- authority high-water cache;
- identifier lookup changes;
- `last_node_index`/WriterState changes;
- other derived Journal indexes/caches maintained by the implementation.

The resulting committed legacy graph equals replay of the resulting committed journal.

If durable publication fails, neither side of that transition becomes visible as committed supported state, and no durable journal sequence position is consumed by that failed transition.

## Bootstrap and migration boundary

Creating Journal 3 from pre-Journal-3 persisted graph state is a migration problem rather than an ordinary local-emission case.

That migration constructs replay history which projects exactly to the accepted legacy semantic graph. Legacy stale nodes may require controlled `"unknown"` basis entries and explicit bootstrap invalidation events to reproduce partial validity/freshness without inventing provenance.

The complete bootstrap/later migration algorithms are specified by `incremental-graph-journal-migrations.md`.
