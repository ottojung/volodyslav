# IncrementalGraph Journal 2 API and Incremental Change Index

## Scope

Journal 2 exposes one private database/journal change-discovery API for synchronization infrastructure:

```text
possibleMaybeChanges(sourceSnapshot, cursor)
```

It is not a method of the public `IncrementalGraph` interface and is not available to ordinary computors. The implementation should keep it behind the database/journal module boundary so only synchronization and closely related internal journal code can import it.

The full synchronization operation remains the normative correctness oracle. This private API only discovers which source node summaries may have changed since a receiver last incorporated that source.

## Cursor identity

`JournalCursor` is defined canonically in `incremental-graph-journal-types.md`.

Its `through` field is explicitly the source writer's local journal sequence coordinate. Remote writers' sequence magnitudes do not affect it.

A cursor is valid for a source snapshot only when:

```text
cursor.source == source.header.writer
cursor.incarnation == source.header.incarnation
cursor.through <= source.header.localJournalCounter
```

A cursor also carries the receiver-local application invariant that the receiver currently represents the source synchronization-relevant state through `through`. A caller must not fabricate a larger cursor.

The field checks above are necessary but not sufficient if the receiver has undergone a lifecycle replacement which destroyed that incorporated-state invariant.

## Reset invalidation

There are two distinct reset cases.

If the **source** resets, its `journalIncarnation` changes and old cursors about that source fail the ordinary cursor field check.

If the **receiver** resets, its stored cursors for other sources still contain those sources' unchanged incarnations. Therefore receiver reset MUST delete all receiver-local stored source cursors atomically. A deleted cursor cannot be used for incremental synchronization; the next synchronization with that source falls back to full synchronization and establishes a fresh cursor after success.

Canonical compaction does not change either source incarnation or the receiver's incorporated-state invariant and therefore does not invalidate valid cursors.

## Private snapshot-scoped iterator

`possibleMaybeChanges(sourceSnapshot, cursor)` operates only on one fixed committed source snapshot supplied and owned by its internal caller.

Let:

```text
S = sourceSnapshot.header.localJournalCounter
```

The result exposes bounded range metadata plus an asynchronous stream:

```text
PossibleMaybeChanges = {
    source: sourceSnapshot.header.writer,
    incarnation: sourceSnapshot.header.incarnation,
    from: cursor.through,
    through: S,
    causalSummary: sourceSnapshot.header.causalSummary,
    authorityClock: sourceSnapshot.header.authorityClock,
    changes: AsyncIterable<{
        node: NodeKey,
        summary: NodeJournalSemanticPart
    }>
}
```

The `changes` iterator range-scans changed-node markers satisfying:

```text
cursor.through < marker.sequence <= S
```

and lazily reads the current `NodeJournalSummary` for each marker's NodeKey from the same `sourceSnapshot` before yielding that one bounded change record.

`lastLocalChange` is local index metadata and need not be copied inside `summary` because the enclosing range metadata establishes the source interval.

The iterator is metadata-only. It does not yield `ComputedValue` payloads or timestamp/value records from legacy sublevels.

The iterator MUST NOT materialize the complete changed-node range as one array or other graph-sized in-memory collection. Aside from implementation/runtime iterator buffers and downstream synchronization state required for other reasons, the change-discovery layer need retain only a constant number of bounded journal records at a time.

## Snapshot lifetime and privacy

The caller that owns `sourceSnapshot` must keep it alive while `changes` is being consumed. The iterator must not escape to public graph code, computors, plugins, or unrelated callers which could retain it across arbitrary graph operations.

Synchronization is the primary consumer and already owns the stable source snapshot required for exact payload acquisition. The private API therefore does not acquire a separate long-lived graph lock or independently control active-replica lifetime; it reads only through the caller-provided stable snapshot.

If iteration completes, fails, or is abandoned, the caller must finish/close the iterator and then release the snapshot according to the synchronization/lifecycle ownership rules. No mutable live-replica handle is exposed through the iterator.

## One result per changed node

The compacted index contains only the latest marker for each represented node. Therefore the stream yields a node at most once per call even if that node changed arbitrarily many times after the cursor.

The yielded summary is the node's complete current synchronization-relevant semantic state at snapshot S, not a replay of each historical event.

## Empty ranges and consumption

A successful `possibleMaybeChanges` call describes the complete snapshot range through S even if the `changes` stream yields nothing.

The caller may persist/advance its source cursor to:

```text
{ source, incarnation, through: S }
```

only after it has fully consumed the stream and successfully incorporated its range metadata and yielded changes according to the synchronization protocol.

The iterator itself does not mutate remote source state.

## Causal and authority header transfer

`causalSummary` and `authorityClock` are transferred in every incremental/full-sync handshake independently of node change markers.

Both may grow on a source merely because it observed another replica, without the source authoring a node-semantic event and therefore without advancing `localJournalCounter` or moving a changed-node marker.

Transferring these header high-water marks separately prevents global causal/authority knowledge from requiring a graph-wide change marker and avoids event-echo protocols. Receiver growth of these header fields alone does not create a local semantic event.

## Compaction-aware semantics

The private iterator intentionally does not promise event-for-event replay.

For a consumer which correctly incorporated the source through P, consuming the current summaries yielded for all markers after P together with the current source causal/authority header must have the same journal-derived synchronization effect as consuming the uncompacted historical source events through S.

This equivalence is specified/proved in `incremental-graph-journal-compaction.md`.

## Source-side index layout

A conforming implementation should support an ordered LevelDB layout equivalent to:

```text
journal/changes/by-sequence/<sequence>/<NodeKey> -> bounded marker value
journal/nodes/<NodeKey>                          -> NodeJournalSummary
```

When K changes at local sequence q:

1. remove K's previous by-sequence marker, if any;
2. write the new marker at q;
3. update `NodeJournalSummary.lastLocalChange = q`;
4. commit those writes atomically with the event/graph transition.

The exact key encoding is implementation-defined provided range iteration is ordered by the source's local sequence and every LevelDB value obeys the `O(R log H)` bit bound.

## Stored source cursors

A synchronization implementation may persist one cursor per remote/source writer inside the new journal sublevel, for example:

```text
journal/cursors/<sourceFingerprint> -> JournalCursor
```

A stored cursor is receiver-local optimization state. It is never merged as semantic graph authority and is never copied into another host's journal as that host's progress.

Controlled receiver reset deletes all such records.

## Incremental synchronization snapshot contract

Incremental synchronization owns one fixed committed source snapshot for the complete source-read phase. It passes that same snapshot to `possibleMaybeChanges` and consumes the returned async stream while the snapshot remains alive.

A yielded changed summary may select a present `ValueId` which the receiver does not materialize. The payload/timestamp record for that exact `ValueId` must come from the **same fixed source snapshot** from which the summary was read. Otherwise the source could replace/delete the value between metadata iteration and payload fetch, yielding a payload from a different semantic state.

While the snapshot is held, incremental synchronization must:

1. read the source header and initialize `possibleMaybeChanges` for the cursor range;
2. consume each changed-node summary lazily;
3. for each yielded present head that may need source materialization, copy or stage the required exact legacy value/timestamp record from that same snapshot;
4. finish the iterator;
5. only then release the source snapshot after all source data needed for the operation has been copied/staged safely.

The copied/staged payloads are transient synchronization data, not journal records. They may be streamed directly into an inactive target replica rather than accumulated in RAM. The journal no-payload constraint and per-LevelDB journal-value size bound do not apply to these ordinary legacy value transfers.

## Incremental synchronization

For a valid stored cursor P for source S:

1. take one fixed committed source snapshot;
2. initialize `possibleMaybeChanges` for P on that snapshot;
3. consume its `changes` async stream, and from the same snapshot copy/stage every legacy payload/timestamp record required by yielded present heads that the receiver cannot otherwise materialize under the full-sync rules;
4. incorporate the returned `causalSummary` and `authorityClock` header high-water marks;
5. semantically merge the yielded node summaries into the receiver's already represented source knowledge;
6. run the same topological normalization rules that full synchronization would run for affected nodes and their dependent closure;
7. materialize selected present heads using only records obtained from the fixed source snapshot or an already-matching receiver `ValueId`;
8. atomically publish receiver graph+journal changes and any joined header high-water metadata;
9. only then advance the stored source cursor to the returned `through` coordinate.

The receiver may need to inspect local dependents outside the yielded source changed-node set because one changed input can alter downstream normalization/freshness. Any graph-sized scratch state required for normalization must be streamable/spillable to bounded-record storage rather than forcing the journal iterator to materialize all source changes in RAM.

## Full-sync equivalence invariant

The source cursor P certifies that every source node summary with `lastLocalChange <= P.through` was already incorporated by the receiver at P.

For a source node unchanged after P, its source semantic authority/frontiers/certificate have not grown. Receiver-local state may have grown, but Journal 2's head/frontier/certificate orders are monotone, so re-reading that unchanged older source summary in a full sync cannot introduce information that the receiver did not already incorporate at P.

Source-global causal or HLC high-water knowledge may nevertheless have grown without changing any node. Because every incremental range transfers the current `causalSummary` and `authorityClock`, incremental synchronization observes the same source-global allocation knowledge that full synchronization would observe from the same source snapshot.

For a changed present node, incremental synchronization reads both the current semantic summary and any required payload/timestamp record from the same source snapshot. Therefore it materializes the same selected source occurrence that full synchronization would inspect from that snapshot.

Consequently processing exactly the yielded changed source summaries after P, joining the current source causal/authority header, acquiring required payloads from the same source snapshot, and applying the same normalization closure yields an observably equivalent result to a full synchronization from the same starting receiver/source snapshots.

This is the required correctness condition for enabling the optimization.

## Invalid cursor behavior

If source identity/incarnation does not match, the receiver-local cursor record is absent (including after reset), progress is malformed, required cursor state is unavailable, or any validation fails, incremental synchronization must not guess. It falls back to full synchronization and, after success, stores a fresh cursor for the source's current incarnation/head.

## No computor API dependency

`possibleMaybeChanges` is private synchronization infrastructure. No computor or public IncrementalGraph operation may obtain its iterator, read a journal cursor, or depend on journal progress for semantic correctness. `pull()` correctness remains defined entirely by the legacy graph plus Journal 2's internally maintained sidecar consistency.
