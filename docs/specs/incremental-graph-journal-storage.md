# IncrementalGraph Journal 3 Local Storage Requirements

## Purpose

This document specifies local storage properties required by Journal 3 without choosing a remote/backend product, changing transport behavior, or prescribing exact LevelDB key names.

Existing IncrementalGraph sublevel formats remain unchanged during Journal 3 work; Journal-specific authoritative/derived state lives in new storage namespaces.

## Required logical state

A conforming local implementation persists enough information to recover:

- every retained Journal record by `JournalRecordId`;
- ordered per-writer ranges;
- retained frontier, explicitly or derivably;
- current local writer identity;
- existing durable compatibility metadata (`global/version`, `global/graph_scheme`);
- matching materialized graph projection;
- optional derived indexes/caches.

Journal records are authoritative semantic history. Index/frontier caches are rebuildable derived state.

## Existing graph sublevels remain projections

Do not embed Journal provenance/causal/synchronization metadata into existing `values`, `freshness`, `valid`, `timestamps`, or identifier record formats.

## One current format per active replica

The active replica's existing `global/version` selects the complete persisted representation, including Journal records/derived metadata.

Journal records carry no independent format discriminator.

During database migration, source active and inactive target replicas may temporarily use different whole-database versions, but each replica individually remains homogeneous.

A target becomes active only after all retained records are rewritten into target canonical representation and semantic migration replay validates.

## Ordered writer ranges

Storage supports logical iteration:

```text
records(author, afterExclusive, throughInclusive)
```

in ascending sequence order without scanning unrelated writers.

## Canonical current record codec

For one database version each Journal record has one canonical persisted representation/meaning.

The codec preserves record ID, event kind/body, causal context, authority time, references, payload/timestamps, reasons/scopes/certificate bases, and writer-state fields.

ValidateEvent basis encoding is self-describing:

```text
{ input: NodeKey, value: ValueId | "unknown" }
```

with unique input keys serialized by canonical persisted NodeKeyString order.

## Causal-context validation support

Storage/import/open validation verifies that semantic-event contexts are genuine closed cuts.

For F=(W,q):

```text
F.context[W] == q - 1
```

and every semantic event E included by F.context satisfies `E.context <= F.context` componentwise.

It is insufficient to validate only that coordinates are within retained frontier.

## Individual record sizing

Journal 3 imposes no compacted-journal total-size bound.

A ValueEvent may contain an application-sized `ComputedValue`, so one record may scale with payload size.

Records remain individually addressable so range streaming/recovery does not require rewriting/loading complete history.

## Atomic local publication

Local storage supports atomic publication of matching graph and finalized Journal records at the supported observation boundary.

Ordinary operations may use one transaction/batch. Synchronization/reset/bootstrap/migration may build inactive target state and atomically cut over.

## Immutable historical identity within one format

Outside explicit database-format migration, a committed `(author,sequence)` body/meaning is never mutated.

A version migration may rewrite every retained record representation only when it deterministically preserves record identity, historical semantic meaning, causal/reference relationships, and writer coordinate.

Representation rewrite itself is not a semantic Journal event.

## Semantic-preserving `override()` storage rewrite

`MigrationStorage.override()` is a semantic-preserving representation rewrite.

If target database format represents a `ComputedValue` differently, the whole-history representation migration may rewrite the payload representation of retained `ValueEvent`s while preserving each record's `JournalRecordId` and semantic meaning.

For the currently selected overridden occurrence, the rewritten target record must agree with the migration's `override()` result while preserving:

- selected ValueId;
- NodeIdentifier;
- createdAt/modifiedAt;
- causal context and authority meaning;
- cross-record references.

A representation-changing override therefore does not append a replacement ValueEvent.

## Semantic migration identity

Database migration preserves existing ValueIds for semantic occurrences retained by `keep`, `override`, `invalidate`, schema/proof/freshness-only changes, and equivalent occurrence-preserving transitions.

When migration genuinely creates/replaces a semantic occurrence, the local migrating writer may author a new ValueEvent. Different replicas may independently create different replacement ValueIds; later synchronization resolves those histories normally and may stale dependents whose certificates name a losing replacement.

Storage does not require or encode a canonical remote migration author.

## Canonical pre-Journal bootstrap storage

For initial legacy->Journal transition, one canonical semantic bootstrap history supplies the shared ValueId basis for a cohort.

A joining host retains those canonical records verbatim, then may additionally persist:

- local bootstrap Value/Delete/Validate/Invalidate delta records required to reproduce its own supported legacy graph;
- its local WriterStateRecord preserving its allocator watermark.

Unaffected equal occurrences continue to reference canonical bootstrap ValueIds.

The configured cohort bootstrap source decides whether the host joins an existing canonical snapshot or is permitted to create the first one. Indeterminate source state never authorizes a second canonical history.

## No destructive replay-history GC

Base Journal 3 does not delete authoritative historical records merely because their current effect can be summarized.

A version migration replacing source-format encodings with target-format encodings of the same records is representation replacement, not semantic compaction.

## Derived indexes

Optional rebuildable indexes may include per-writer head/frontier, record-by-node history, selected current head, candidate certificate/invalidation indexes, reverse structural edges, authority high-water, context-closure summaries, and replay checkpoint references.

Derived data never becomes independent semantic authority.

## Stable local snapshots

When local storage supplies a `JournalSyncSource`, it provides one stable snapshot containing from the same committed state:

- exact `databaseVersion`;
- exact `graphSchemeString`;
- `localWriter`;
- fixed frontier;
- corresponding immutable records.

Journal 3 does not specify how an external transport supplies an equivalent stable snapshot.

## Startup validation

Before retained history is relied on as supported semantic evidence the implementation enforces current-format decoding, writer contiguity, exact own-prefix event contexts, transitive context closure, authority extension, ValueId reference causality, canonical certificate shape, and Journal/projection consistency or successful rebuild.

Malformed authoritative history is rejected rather than repaired from mutable graph bytes.