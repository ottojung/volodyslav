# IncrementalGraph Journal 2 API and Incremental Change Index

## Scope

Journal 2 initially exposes iteration for synchronization infrastructure. Ordinary computors do not receive journal iterators and do not depend on journal progress for semantic correctness.

The full synchronization operation remains the normative correctness oracle. This API only discovers which source node summaries may have changed since a receiver last incorporated that source.

## Cursor identity

A durable cursor is:

```text
JournalCursor = {
    source: DatabaseFingerprint,
    incarnation: JournalIncarnation,
    through: JournalSequence | 0
}
```

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

## Stable snapshot iteration

`iterate(cursor)` operates on one fixed committed source snapshot.

Let:

```text
S = snapshot.header.localJournalCounter
```

The operation reads the ordered changed-node marker index for markers satisfying:

```text
cursor.through < marker.sequence <= S
```

For each marker, it returns the current `NodeJournalSummary` for that NodeKey from the same snapshot.

The result is conceptually:

```text
JournalDelta = {
    source: source.header.writer,
    incarnation: source.header.incarnation,
    from: cursor.through,
    through: S,
    causalSummary: source.header.causalSummary,
    changes: Array<{
        node: NodeKey,
        summary: NodeJournalSemanticPart
    }>
}
```

`lastLocalChange` is local index metadata and need not be copied inside `summary` because the enclosing delta establishes the source range.

`JournalDelta` is metadata-only. It does not contain `ComputedValue` payloads or timestamp/value records from legacy sublevels.

## One result per changed node

The compacted index contains only the latest marker for each represented node. Therefore `changes` contains a node at most once per iteration call even if that node changed arbitrarily many times after the cursor.

The returned summary is the node's complete current synchronization-relevant semantic state at snapshot S, not a replay of each historical event.

## Empty ranges and consumption

A successful iteration consumes the complete snapshot range through S, even if `changes` is empty.

The caller may persist/advance its source cursor to:

```text
{ source, incarnation, through: S }
```

only after it has successfully incorporated the returned delta according to the synchronization protocol.

The iterator object itself does not mutate remote source state.

## Causal header transfer

`causalSummary` is transferred in every delta/full-sync handshake independently of node change markers.

This prevents global causal knowledge from requiring a graph-wide change marker and avoids event-echo protocols. Receiver growth of causal summary alone does not create a local event.

## Compaction-aware semantics

The API intentionally does not promise event-for-event replay.

For a consumer which correctly incorporated the source through P, applying the returned current summaries for all markers after P must have the same journal-derived synchronization effect as consuming the un-compacted historical source events through S.

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

The exact key encoding is implementation-defined provided range iteration is ordered by sequence and every LevelDB value obeys the `O(R log H)` bit bound.

## Stored source cursors

A synchronization implementation may persist one cursor per remote/source writer inside the new journal sublevel, for example:

```text
journal/cursors/<sourceFingerprint> -> JournalCursor
```

A stored cursor is receiver-local optimization state. It is never merged as semantic graph authority and is never copied into another host's journal as that host's progress.

Controlled receiver reset deletes all such records.

## Incremental synchronization snapshot contract

Incremental synchronization cannot be implemented by calling metadata-only `iterate(cursor)`, releasing its source snapshot, and later reopening the source database to fetch payloads.

A returned changed summary may select a present `ValueId` which the receiver does not materialize. The payload/timestamp record for that exact `ValueId` must come from the **same fixed source snapshot** from which the summary was read. Otherwise the source could replace/delete the value between metadata iteration and payload fetch, yielding a payload from a different semantic state.

Therefore the incremental synchronization operation itself owns one fixed source snapshot for the complete source-read phase. While that snapshot is held it must:

1. read the source header and changed-node summaries for the cursor range;
2. determine which returned present heads may need source payload/timestamp records;
3. copy or stage every required exact legacy value/timestamp record from that same snapshot;
4. only then release the source snapshot.

The copied/staged payloads are transient synchronization data, not journal records. They may be streamed directly into an inactive target replica rather than accumulated in RAM. The journal no-payload constraint and per-LevelDB journal-value size bound do not apply to these ordinary legacy value transfers.

No LevelDB snapshot or mutable source-replica handle may escape to an external/slow iterator consumer.

## Incremental synchronization

For a valid stored cursor P for source S:

1. take one fixed committed source snapshot;
2. read the metadata delta for P from that snapshot;
3. from the same snapshot, copy/stage every legacy payload/timestamp record required by changed present heads that the receiver cannot otherwise materialize under the full-sync rules;
4. join the returned causal header;
5. semantically merge only the returned node summaries into the receiver's already represented source knowledge;
6. run the same topological normalization rules that full synchronization would run for affected nodes and their dependent closure;
7. materialize selected present heads using only records obtained from the fixed source snapshot or an already-matching receiver `ValueId`;
8. atomically publish receiver graph+journal changes;
9. only then advance the stored source cursor to `delta.through`.

The source snapshot may be released after step 3 once all source data needed for the operation has been copied/staged safely.

The receiver may need to inspect local dependents outside the returned source changed-node set because one changed input can alter downstream normalization/freshness.

## Full-sync equivalence invariant

The source cursor P certifies that every source node summary with `lastLocalChange <= P.through` was already incorporated by the receiver at P.

For a source node unchanged after P, its source semantic authority/frontiers/certificate have not grown. Receiver-local state may have grown, but Journal 2's head/frontier/certificate orders are monotone, so re-reading that unchanged older source summary in a full sync cannot introduce information that the receiver did not already incorporate at P.

For a changed present node, incremental synchronization reads both the current semantic summary and any required payload/timestamp record from the same source snapshot. Therefore it materializes the same selected source occurrence that full synchronization would inspect from that snapshot.

Consequently processing exactly the changed source summaries after P, acquiring their required payloads from the same source snapshot, and applying the same normalization closure yields an observably equivalent result to a full synchronization from the same starting receiver/source snapshots.

This is the required correctness condition for enabling the optimization.

## Invalid cursor behavior

If source identity/incarnation does not match, the receiver-local cursor record is absent (including after reset), progress is malformed, required cursor state is unavailable, or any validation fails, incremental synchronization must not guess. It falls back to full synchronization and, after success, stores a fresh cursor for the source's current incarnation/head.

## No computor API dependency

No Journal 2 correctness rule requires a computor to read or persist a cursor. `pull()` correctness remains defined entirely by the legacy graph plus Journal 2's internally maintained sidecar consistency.