# Journal 3 in One Page

Journal 3 is an append-only replay log for IncrementalGraph.

```text
current graph = project(retained journal)
```

The graph is a materialized view. The journal is authority.

## History

Each `DatabaseFingerprint` owns one immutable writer stream:

```text
A:1, A:2, ...
```

A database may retain prefixes from many writers. Synchronization copies foreign records verbatim.

A record ID never changes meaning and authoritative records are not destructively compacted.

## Events

Core semantic events:

- ValueEvent — exact value occurrence including payload/timestamps/NodeIdentifier;
- DeleteEvent — semantic absence authority;
- ValidateEvent — proof for one ValueId against direct input ValueIds;
- InvalidateEvent — node- or value-scoped stale/proof invalidation.

WriterStateRecord reconstructs local `last_node_index`.

Every record has `recordVersion`.

## Causality/conflicts

Semantic events carry a causal frontier and HLC-style authority.

Happened-before must imply greater authority.

Concurrent value/delete heads use total authority as deterministic precedence.

Validation only clears node invalidation causally, not merely because its total authority is later.

Every referenced ValueId must be causally prior to the referencing event.

## Local operations

Graph operations stage journal intents.

During serialized commit finalization, the implementation determines the actual committed graph transition, allocates contiguous writer sequences/HLC authority, resolves same-publication references, and commits graph+journal atomically.

Failed operations create no journal holes.

## Replay

Replay selects current value/delete heads, selects a sound validation certificate, applies invalidation semantics, derives freshness/validity, and lowers the result into existing graph sublevels.

Replay does not run computors, migrations, network calls, randomness, or historical operations.

## Synchronization

One stable source snapshot supplies exact writer prefixes.

Receiver streams every missing suffix, validates overlap/causality, unions immutable history, authors only genuinely required receiver normalization, replays, validates, and atomically cuts over.

Important normalization:

- selected cached nodes whose required input is absent receive explicit structural DeleteEvents over dependent closure;
- receiver values which transition fresh->stale while retaining the same ValueId receive persistent value-scoped sync invalidation when history does not already represent that transition.

Full sync is the same algorithm from frontier zero.

Repeating unchanged sync is a semantic no-op.

## Same-writer recovery

Exact shorter prefix may recover a longer exact own-writer suffix and then continue after the recovered head.

Conflicting same-ID bodies are a hard fork/corruption error.

## Reset

Reset does not erase history.

It observes/imports the chosen source and appends a causally later local baseline whose projection matches the source target.

## Migration

Initial bootstrap records a baseline equivalent to the legacy graph.

Later migrations retain old history and append a complete target-state baseline. Replay never reruns the historical migration callback.

## Storage/transport

Existing graph record formats remain unchanged during Journal 3 work.

Journal history lives in new storage.

Concrete remote/backend protocol is not specified yet; synchronization depends only on the stable journal-snapshot abstraction.

## Core test

For every supported committed state:

```text
persisted graph == project(retained journal)
```

If that equality cannot be reconstructed from the journal alone, the Journal 3 design/implementation is incomplete.
