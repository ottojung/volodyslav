# IncrementalGraph Journal 2 Emission

## Purpose

This specification maps supported IncrementalGraph transitions to local Journal 2 history and compacted summary changes.

All graph and journal writes described as one transition are committed atomically.

## High-level operation records

A supported public/lifecycle operation may allocate one small local `OperationRecord` before or as part of committing the low-level semantic events directly produced by that operation.

Examples include:

```text
pull(K)
invalidate(K)
synchronize(source)
reset(source)
migration(...)
```

The operation record uses `localOperationCounter`, not the semantic `localJournalCounter`. It therefore has no semantic authority and does not affect causal ordering or conflict selection.

When an operation record is persisted, its tagged arguments MUST identify the recorded invocation according to `incremental-graph-journal-types.md`:

- `pull` and `invalidate` record their `subject` NodeKey;
- `synchronize` records the source database plus its Journal 2 incarnation, local semantic head, causal summary, and authority-clock high-water mark from the exact stable source snapshot consumed by the operation;
- `reset` records the chosen valid compatible Journal 2 source with the same complete source-position metadata;
- `migration` records the stable `MigrationId` of the migration being run;
- implementation-specific `other` operations use a bounded stable `OperationTag` rather than arbitrary payload data.

Every low-level semantic event directly produced by that operation may carry:

```text
operation: OperationId
```

The conceptual compiled expansion of an operation is the set/list of low-level historical events carrying that operation ID. The operation record itself MUST NOT store an array of those events, because one operation may affect O(N) nodes and every journal LevelDB value must remain individually bounded.

Nested pulls/operations may receive distinct operation IDs. When the direct caller's `OperationId` is safely known, the child operation record may store it as `parent`. No parent operation is required to contain an unbounded list of nested operation IDs, and Journal 2 does not require a complete transitive call tree.

If an operation produces no journal-relevant semantic event, an implementation may omit its `OperationRecord`; Journal 2 does not require no-op calls to produce history solely for tracing.

## Semantic event allocation

Every locally authored semantic journal event uses the canonical writer-local identity, causal-context, and HLC authority allocator defined in `incremental-graph-journal-types.md`. This specification does not redefine that allocator.

Publication must allocate against the current serialized Journal 2 header after joining every causal/authority fact the operation is required to have observed. Remote causal coordinates remain remote coordinates and never inflate the writer-local event sequence.

The physical seed supplied to the canonical HLC allocator is:

- the exact new value record's legacy `modifiedAt` for a `ValueEvent`;
- the operation/publication wall-clock time for validate, invalidate, delete, and adopt events.

For a value-changing computation, the new legacy timestamp is therefore determined before/finalized together with allocation of its `ValueEvent`, so the event's physical HLC seed and the committed value occurrence's `modifiedAt` correspond to the same semantic transition.

When one atomic transaction authors multiple semantic events, their allocation order must be a deterministic topological order extending every semantic happened-before constraint established by the transition being recorded. In particular:

- a `ValueEvent` precedes every `ValidateEvent` which names that new `ValueId`;
- an invalidating/value-changing transition precedes any propagated `InvalidateEvent` whose stale transition it causes;
- reset/bootstrap `ValueEvent`s for input nodes precede certificates whose basis refers to those new input `ValueId`s;
- a synchronization normalization event which makes a dependent non-materializable precedes a dependent destructive event authored because of that fact.

Events not ordered by such semantic dependencies are tie-broken according to the deterministic ordering required by the operation-specific specification. Ordinary local operations use canonical `NodeKey`/event-kind tie-breakers; migration/reset value-baseline allocation uses the timestamp-first order specified by their lifecycle documents. No deterministic tie-break may reverse a required semantic dependency merely to obtain stable IDs.

Because later same-author events have larger local sequences, include earlier same-transaction events in their contexts, and advance the HLC again, this allocation order is part of both exact causal meaning and authority monotonicity rather than merely a serialization convenience.

Allocating or writing an `OperationRecord` does not advance `localJournalCounter`, `causalSummary`, or `authorityClock`.

## Value-changing computation

When a successful computor returns a semantic value different from the currently stored value, or materializes a previously absent node:

1. determine the new legacy value/timestamp record using the existing IncrementalGraph timestamp rules;
2. author `ValueEvent V`, seeding its HLC physical component from that record's `modifiedAt`;
3. `V.id` becomes the new `ValueId` and `V` becomes the present-head authority reference;
4. write the new payload only to the unchanged legacy `values` sublevel;
5. preserve/update timestamps according to the existing IncrementalGraph rules;
6. author `ValidateEvent C` for `V.id`;
7. set `C.basis[i] = currentValueId(inputEdges(K)[i])` for every direct input;
8. project K fresh and restore its incoming validity edges;
9. perform ordinary outgoing invalidation propagation caused by the value change.

The directly authored `ValueEvent`, `ValidateEvent`, and propagated low-level events carry the current high-level operation ID when one was allocated for the pull.

Every dependent whose legacy freshness actually changes from fresh to stale due to propagation receives a value-scoped `InvalidateEvent` naming that dependent's current `ValueId`.

The new value event itself explains loss of incoming validity edges in dependents whose certificate basis still names the old input `ValueId`; no separate dependent event is required merely because a `valid` edge disappears while the dependent was already stale.

## Unchanged computation

When the computor is invoked and returns `Unchanged`:

- preserve the current `ValueId` and its original `ValueRef.authorityTime`;
- author a new `ValidateEvent` for that `ValueId` using the current operation time as its HLC physical seed;
- record the exact current direct-input `ValueId`s in its basis;
- its context clears every applicable invalidation which the operation observed;
- project the resulting legacy freshness/validity state normally.

No `ValueEvent` is authored and the legacy value's `modifiedAt` does not change.

## Cache revalidation

When a stale derived node has complete current incoming validity and revalidates without invoking its computor:

- preserve the current `ValueId` and original value authority;
- author a new `ValidateEvent` with the current direct-input `ValueId` basis;
- mark the node fresh in the legacy graph;
- preserve its outgoing validity frontier according to the existing graph algorithm.

This validation is a real low-level semantic journal event even though the payload did not change.

## Fresh fast path

A pull which returns an already-fresh cached node without changing any graph or journal-derived fact authors no semantic event. It need not persist an operation record.

## Explicit invalidation

A public explicit invalidation of materialized node K authors:

```text
InvalidateEvent {
    scope: { kind: "node" },
    reason: "explicit"
}
```

The event advances `nodeInvalidateFrontier[K][localAuthor]` at its writer-local event sequence.

The legacy transition remains the existing one:

- K becomes stale;
- K's incoming validity edges are removed;
- stale propagation walks the existing outgoing validity frontier.

Each dependent whose freshness changes from fresh to stale receives one value-scoped invalidation:

```text
InvalidateEvent {
    scope: { kind: "value", value: currentValueId(dependent) },
    reason: "propagated"
}
```

These directly produced low-level invalidation events share the high-level invalidate operation ID when one is allocated.

A dependent already stale does not receive another invalidation merely because the traversal reaches it again without changing its graph state.

## Deletion

A semantic deletion authors `DeleteEvent D`; `D` becomes the absent-head authority reference for the node.

Publication removes the node's legacy materialization and validity entries while preserving the compacted node summary/tombstone in the new journal sublevel.

The journal stores no deleted payload.

A later present semantic occurrence must have greater EventRef authority to defeat the tombstone.

## Synchronization adoption

When synchronization represents a source semantic fact without creating a new semantic fact, it authors a local `AdoptEvent` only if the receiver's synchronization-relevant node summary or legacy graph actually changes.

Examples include:

- adopting a higher foreign present head and copying its payload;
- adopting a higher foreign tombstone;
- adopting a greater certificate for the same current value;
- joining previously unseen foreign invalidation frontier coordinates;
- projecting a resulting freshness/validity change caused by those adopted facts.

The event carries bounded references/summary metadata but creates no new `ValueId`, certificate authority, invalidation authority, or tombstone authority. The adopted foreign identities and their immutable authority times remain unchanged.

All low-level events directly produced by one synchronization operation may share one local synchronization `OperationId`. When that operation record is persisted, its `source` identifies the same fixed Journal 2 source snapshot used by the synchronization protocol, including incarnation, local head, causal summary, and authority-clock high-water mark. That grouping is historical only and is not imported by peers.

If source information is already represented and the graph projection is unchanged, repeating synchronization is silent and need not persist an operation record.

## Synchronization-authored stale invalidation

A merged graph can create one special case not already represented by either side: a node's certificate basis still exactly matches all final input `ValueId`s, but one of those final inputs becomes stale due to information from the other replica.

If K would otherwise become fresh again automatically when that input later revalidates unchanged, synchronization must author one value-scoped invalidation for K. This records the same persistent stale transition that the ordinary local invalidation propagation algorithm would have recorded.

The invalidation is authored only when no already represented uncovered value-scoped invalidation supplies that stale authority.

## Synchronization-authored structural discard

If full synchronization selects a present cached node but a required direct input is finally absent, dependency closure forbids retaining that materialization. The receiver authors:

```text
DeleteEvent {
    reason: "sync-discard"
}
```

Before authoring the delete, synchronization has joined the causal contexts and authority-clock high-water marks of every source/local authority it relied on. The resulting delete is therefore both causally after those observed facts and greater than them in the HLC authority order.

The removal may cascade to cached dependents which can no longer remain materialized because the legacy graph is dependency-closed. This is structural cache destruction, not a promise that the semantic node can never exist again: a later successful pull may rematerialize the required inputs, recompute the node, and author a new greater value occurrence.

Synchronization does not use `sync-discard` merely because a retained cache's final inputs have mixed provenance or no longer match its certificate basis. Such a cache remains available as ordinary stale `oldValue` according to the existing graph algorithm and `$id-8254606583674715`.

## Reset and migration grouping

A controlled reset or migration may allocate one local high-level operation record and attach that operation ID to the O(N) low-level reset/bootstrap semantic events it produces.

A reset operation record identifies its chosen source using `OperationSourceRef`. A migration operation record identifies the migration with a stable bounded `MigrationId`.

The operation record remains individually bounded in graph size. It MUST NOT enumerate all affected NodeKeys or all compiled semantic events in one LevelDB value.

## Summary folding

Every semantic event updates the node's compacted semantic summary in the same transaction. The fold rules are:

- value/delete events replace the state head when their EventRef authority is greater;
- a value event resets value-specific certificate/invalidation state for the new `ValueId`;
- validate retains only the greatest certificate for the current `ValueId` by certificate EventRef authority;
- node invalidates advance `nodeInvalidateFrontier` by writer-local author coordinate;
- current-value invalidates advance `valueInvalidateFrontier`;
- adopt joins the bounded foreign semantic state described in the sync specification;
- every local node-summary change sets `lastLocalChange` to the local semantic event sequence and moves that node's change-index marker atomically.

The event's optional `operation` reference is ignored by semantic folding.

Raw historical semantic events and operation grouping may later be removed by canonical compaction.

## Causal/authority observation without echo

Receiving a source `causalSummary` and `authorityClock` is genuine observation, but growth of those receiver header high-water marks alone does not author a new semantic journal event.

This rule is required to avoid infinite acknowledgement chains in which A observing B creates A:event, B observing that event creates B:event, and so on despite no semantic or node-summary change.

A later real local semantic event naturally includes the accumulated causal summary in its context and advances from the accumulated authority-clock high-water mark.

## Atomicity

For any operation which changes both old graph sublevels and journal state, the durable batch includes:

- all legacy graph writes/deletes;
- any high-level operation record/local operation-counter update being persisted for the transition;
- raw newly authored semantic journal events;
- updated node summaries;
- moved changed-node markers;
- header local sequence, causal-summary, and authority-clock metadata;
- any identifier-map changes required by the legacy graph.

No reader may observe only one side of this publication.
