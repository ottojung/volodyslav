# IncrementalGraph Journal 2 Emission

## Purpose

This specification maps supported IncrementalGraph transitions to local Journal 2 history and compacted summary changes.

All graph and journal writes described as one transition are committed atomically.

## Event allocation

Every locally authored journal event uses the allocation rule in `incremental-graph-journal-types.md`:

```text
next = 1 + max(localJournalCounter, causalSummary[*])
```

The event receives the current causal summary as immutable context. Events in one transaction are allocated in deterministic NodeKey/kind order after the operation's semantic result is known.

Imported semantic authorities are joined into `causalSummary` before any synchronization-authored semantic event is allocated.

## Value-changing computation

When a successful computor returns a semantic value different from the currently stored value, or materializes a previously absent node:

1. author `ValueEvent V` for the node;
2. `V.id` becomes the new `ValueId` and present head authority;
3. write the new payload only to the unchanged legacy `values` sublevel;
4. preserve/update timestamps according to the existing IncrementalGraph rules;
5. author `ValidateEvent C` for `V.id`;
6. set `C.basis[i] = currentValueId(inputEdges(K)[i])` for every direct input;
7. project K fresh and restore its incoming validity edges;
8. perform ordinary outgoing invalidation propagation caused by the value change.

Every dependent whose legacy freshness actually changes from fresh to stale due to propagation receives a value-scoped soft `InvalidateEvent` naming that dependent's current `ValueId`.

The new value event itself explains loss of incoming validity edges in dependents whose certificate basis still names the old input `ValueId`; no separate dependent event is required merely because a `valid` edge disappears while the dependent was already stale.

## Unchanged computation

When the computor is invoked and returns `Unchanged`:

- preserve the current `ValueId`;
- author a new `ValidateEvent` for that `ValueId`;
- record the exact current direct-input `ValueId`s in its basis;
- its context clears every applicable invalidation which the operation observed;
- project the resulting legacy freshness/validity state normally.

No `ValueEvent` is authored.

## Cache revalidation

When a stale derived node has complete current incoming validity and revalidates without invoking its computor:

- preserve the current `ValueId`;
- author a new `ValidateEvent` with the current direct-input `ValueId` basis;
- mark the node fresh in the legacy graph;
- preserve its outgoing validity frontier according to the existing graph algorithm.

This validation is a real journal event even though the payload did not change.

## Fresh fast path

A pull which returns an already-fresh cached node without changing any graph or journal-derived fact authors no event.

## Explicit invalidation

A public explicit invalidation of materialized node K authors:

```text
InvalidateEvent {
    scope: { kind: "node" },
    mode: "hard",
    reason: "explicit"
}
```

The event advances `nodeInvalidateFrontier[K][localAuthor]`.

The legacy transition remains the existing one:

- K becomes stale;
- K's incoming validity edges are removed;
- stale propagation walks the existing outgoing validity frontier.

Each dependent whose freshness changes from fresh to stale receives one value-scoped soft invalidation:

```text
InvalidateEvent {
    scope: { kind: "value", value: currentValueId(dependent) },
    mode: "soft",
    reason: "propagated"
}
```

A dependent already stale does not receive another soft invalidation merely because the traversal reaches it again without changing its graph state.

## Value-scoped hard invalidation

Journal 2 permits a synchronization or controlled lifecycle operation to retain one present cache while intentionally breaking all of its incoming proof. Such a transition authors a value-scoped hard invalidation.

The initial full-sync design should prefer deletion for a cache whose `oldValue` admissibility cannot be proved; value-scoped hard invalidation is reserved for cases where retaining the payload is separately proven safe.

## Deletion

A semantic deletion authors `DeleteEvent D`; `D` becomes the absent head authority for the node.

Publication removes the node's legacy materialization and validity entries while preserving the compacted node summary/tombstone in the new journal sublevel.

The journal stores no deleted payload.

A later present semantic occurrence must have greater state authority to defeat the tombstone.

## Synchronization adoption

When synchronization represents a source semantic fact without creating a new semantic fact, it authors a local `AdoptEvent` only if the receiver's synchronization-relevant node summary or legacy graph actually changes.

Examples include:

- adopting a higher foreign present head and copying its payload;
- adopting a higher foreign tombstone;
- adopting a greater certificate for the same current value;
- joining previously unseen foreign invalidation frontier coordinates;
- projecting a resulting freshness/validity change caused by those adopted facts.

The event carries bounded references/summary metadata but creates no new `ValueId`, certificate authority, invalidation authority, or tombstone authority. The adopted foreign identities remain unchanged.

If source information is already represented and the graph projection is unchanged, repeating synchronization is silent.

## Synchronization-authored soft invalidation

A merged graph can create one special case not already represented by either side: a node's certificate basis still exactly matches all final input `ValueId`s, but one of those final inputs becomes stale due to information from the other replica.

If K would otherwise become fresh again automatically when that input later revalidates unchanged, synchronization must author one value-scoped soft invalidation for K. This records the same persistent stale transition that the ordinary local invalidation propagation algorithm would have recorded.

The soft invalidation is authored only when no already represented uncovered invalidation supplies that stale authority.

## Synchronization-authored discard

If full synchronization selects a present cached value which cannot safely remain available as `oldValue` under the merged history, the receiver authors:

```text
DeleteEvent {
    reason: "sync-discard"
}
```

The delete is causally after every source/local authority observed by that synchronization transaction and therefore has greater total authority than those observed candidates.

This is the only permitted way for synchronization to solve an unsafe cache when the payload cannot remain in the legacy graph: the journal never hides or stores the payload.

## Summary folding

Every event updates the node's compacted semantic summary in the same transaction. The fold rules are:

- value/delete events replace the state head when their authority is greater;
- a value event resets value-specific certificate/invalidation state for the new `ValueId`;
- validate retains only the greatest certificate for the current `ValueId`;
- node invalidates advance `nodeInvalidateFrontier` by author coordinate;
- current-value invalidates advance the corresponding value-specific frontier;
- adopt joins the bounded foreign semantic state described in the sync specification;
- every local node-summary change sets `lastLocalChange` to the local event sequence and moves that node's change-index marker atomically.

Raw historical events may later be removed by canonical compaction.

## Causal-summary observation without echo

Receiving a source `causalSummary` is genuine observation, but growth of receiver `causalSummary` alone does not author a new journal event.

This rule is required to avoid infinite acknowledgement chains in which A observing B creates A:event, B observing that event creates B:event, and so on despite no semantic or node-summary change.

A later real local event naturally includes the accumulated causal summary in its context.

## Atomicity

For any operation which changes both old graph sublevels and journal state, the durable batch includes:

- all legacy graph writes/deletes;
- raw newly authored journal events;
- updated node summaries;
- moved changed-node markers;
- header counter/causal metadata;
- any identifier-map changes required by the legacy graph.

No reader may observe only one side of this publication.