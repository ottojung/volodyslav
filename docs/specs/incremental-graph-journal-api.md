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

A cursor also carries the application-level invariant that the consumer has correctly incorporated this source's synchronization-relevant state through `through`. A caller must not fabricate a larger cursor.

## Reset invalidation

Controlled reset increments the source journal incarnation. Every cursor issued for an older incarnation is invalid and must cause incremental synchronization to fall back to full synchronization.

Canonical compaction does not change the incarnation and therefore does not invalidate cursors.

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

## Incremental synchronization

For a valid stored cursor P for source S:

1. take a fixed source snapshot;
2. obtain `JournalDelta(P)`;
3. join the returned causal header;
4. semantically merge only the returned node summaries into the receiver's already represented source knowledge;
5. run the same topological normalization rules that full synchronization would run for affected nodes and their dependent closure;
6. atomically publish receiver changes;
7. only then advance the stored source cursor to `delta.through`.

The receiver may need to inspect local dependents outside the returned source changed-node set because one changed input can alter downstream normalization/freshness.

## Full-sync equivalence invariant

The source cursor P certifies that every source node summary with `lastLocalChange <= P.through` was already incorporated by the receiver at P.

For a source node unchanged after P, its source semantic authority/frontiers/certificate have not grown. Receiver-local state may have grown, but Journal 2's head/frontier/certificate orders are monotone, so re-reading that unchanged older source summary in a full sync cannot introduce information that the receiver did not already incorporate at P.

Therefore processing exactly the changed source summaries after P, followed by the same normalization closure, yields an observably equivalent result to a full synchronization from the same starting receiver/source snapshots.

This is the required correctness condition for enabling the optimization.

## Invalid cursor behavior

If source identity/incarnation does not match, progress is malformed, required cursor state is unavailable, or any validation fails, incremental synchronization must not guess. It falls back to full synchronization and, after success, stores a fresh cursor for the source's current incarnation/head.

## No computor API dependency

No Journal 2 correctness rule requires a computor to read or persist a cursor. `pull()` correctness remains defined entirely by the legacy graph plus Journal 2's internally maintained sidecar consistency.