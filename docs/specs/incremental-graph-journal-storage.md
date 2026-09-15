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

The materialized graph stores replay output; authoritative history remains in Journal storage.

## One current format per active replica

The active replica's existing `global/version` selects the complete persisted representation, including Journal records/derived metadata.

Journal records carry no independent format discriminator.

During database migration, source active and inactive target replicas may temporarily use different whole-database versions, but each replica individually remains homogeneous.

A target becomes active only after all retained records are rewritten into target canonical representation and semantic migration replay validates.

## Ordered writer ranges

Storage must support logical iteration:

```text
records(author, afterExclusive, throughInclusive)
```

in ascending sequence order without scanning unrelated writers.

This local requirement does not establish the future end-to-end sync time theorem deferred to #1607.

## Canonical current record codec

For one database version each Journal record has one canonical persisted representation/meaning.

The codec preserves exactly:

- record ID;
- event kind/body;
- causal context;
- authority time;
- NodeKey/NodeIdentifier/ValueId references;
- payload/timestamps;
- reasons/scopes/certificate bases;
- writer-state fields.

ValidateEvent basis encoding is self-describing:

```text
{ input: NodeKey, value: ValueId | "unknown" }
```

with unique input keys serialized by canonical persisted NodeKeyString order.

No historical schema input ordering is required merely to decode/canonicalize a retained certificate.

## Causal-context validation support

Storage/import/open validation must be able to verify that semantic-event contexts are genuine closed cuts.

For F=(W,q):

```text
F.context[W] == q - 1
```

and every semantic event E included by F.context must satisfy:

```text
E.context <= F.context
```

componentwise.

It is therefore insufficient to validate only:

```text
F.context[A] <= retainedFrontier[A]
```

A context which points entirely at retained coordinates but omits a transitive causal predecessor is malformed.

Derived validation caches/indexes may accelerate this check, but their corruption cannot redefine event causality.

## Individual record sizing

Journal 3 imposes no compacted-journal total-size bound.

A ValueEvent may contain an application-sized `ComputedValue`, so one record may scale with payload size.

Records should remain individually addressable rather than one monolithic ever-growing value so range streaming/recovery does not require rewriting/loading complete history.

## Atomic local publication

Local storage must support atomic publication of matching graph and finalized Journal records at the supported observation boundary.

Ordinary operations may use one storage transaction/batch.

Synchronization/reset/bootstrap/migration may build inactive target state and atomically cut over.

The requirement is semantic atomicity, not one mandated fsync/storage-engine API.

## Immutable historical identity

Outside explicit database-format migration, a committed `(author,sequence)` body/meaning is never mutated.

Allowed ordinary physical operations include read/copy/backup and derived index creation/rebuild/removal.

A version migration may rewrite every retained record representation only when it deterministically preserves record identity, historical meaning, causal/reference relationships, and writer coordinate.

Representation rewrite itself is not a semantic Journal event.

## Semantic migration identity

Database migration must preserve existing ValueIds for semantic value occurrences it keeps unchanged.

Changing schema/proof/freshness alone may append new Validate/Invalidate history but does not justify replacing the ValueEvent record.

When migration genuinely creates/replaces semantic occurrences, peers in one synchronization cohort retain the canonical semantic migration records defined by the migration lifecycle rather than storing independently-created equivalent occurrences.

Storage layout does not prescribe how those canonical records are transported.

## Canonical pre-Journal bootstrap storage

For initial legacy->Journal transition, cohort peers retain one canonical semantic bootstrap history rather than separately-created equivalent baselines.

A joining host may additionally author/persist its own local WriterStateRecord to preserve its own allocation watermark while retaining the shared semantic bootstrap ValueIds/certificates unchanged.

## No destructive replay-history GC

Base Journal 3 does not delete authoritative historical records merely because their current effect can be summarized.

A version migration replacing source-format encodings with target-format encodings of the same records is representation replacement, not semantic compaction.

Future archival is allowed only if retained historical identity/meaning remains recoverable; an archival protocol is outside this core specification.

## Derived indexes

Optional rebuildable indexes may include:

- per-writer head/frontier;
- record-by-node history;
- selected current Value/Delete head;
- candidate certificate/invalidation indexes;
- reverse structural edges;
- cached authority high-water;
- context-closure validation summaries;
- replay checkpoint references.

Derived data never becomes independent semantic authority.

## Stable local snapshots

When local storage supplies a `JournalSyncSource`, it must provide one stable snapshot containing from the same committed state:

- exact `databaseVersion`;
- exact `graphSchemeString`;
- `localWriter`;
- fixed frontier;
- corresponding immutable records.

Journal 3 does not specify how an external transport supplies an equivalent stable snapshot.

## Startup validation

Validation may be incremental/cached for performance, but before retained history is relied on as supported semantic evidence the implementation must enforce:

- current-format decoding;
- writer contiguity;
- exact own-prefix event contexts;
- transitive context closure;
- authority extension of happened-before;
- ValueId reference causality;
- canonical certificate shape;
- Journal/projection consistency or successful rebuild.

Malformed authoritative history is rejected rather than repaired from mutable graph bytes.