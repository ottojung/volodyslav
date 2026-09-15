# IncrementalGraph Journal 3 Local Storage Requirements

## Purpose

This document specifies storage properties required by Journal 3 without choosing a concrete backend/remote product, changing an existing transport protocol, or prescribing exact LevelDB key names.

The current implementation is expected to use new local database sublevels consistent with the intent that existing graph sublevel representations remain unchanged during Journal 3 work.

## Required logical collections

A conforming local implementation must persist enough information to recover:

- every journal record by `JournalRecordId`;
- ordered per-writer range iteration;
- the retained frontier (either explicitly or derivably);
- current local writer identity;
- existing durable compatibility metadata `global/version` and `global/graph_scheme` as part of the selected replica state;
- any derived indexes chosen for performance.

Journal records are authoritative historical state.

A frontier/index cache may be reconstructed by scanning records if necessary; its physical presence is not semantic authority.

## Existing graph sublevels remain projections

Journal 3 work must not embed journal metadata into existing persisted graph record formats such as:

- `values`;
- `freshness`;
- `valid`;
- `timestamps`;
- identifier-map entries.

Journal records and journal-derived indexes live in new storage namespaces/sublevels.

The exact names/layout are implementation choices unless separately standardized.

## One format per replica

The current replica's existing `global/version` value selects the persisted representation of the entire replica, including journal records and journal-derived metadata.

A supported active replica contains only that version's current journal record format. Journal records do not carry their own version discriminator, and ordinary storage/replay code does not retain compatibility codecs for multiple record formats inside one replica.

`global/graph_scheme` is likewise part of the selected replica's durable interpretation boundary. Ordinary synchronization/reset requires exact source/receiver equality of both the current version and exact stored graph-scheme string.

During a database migration, the old active replica and an inactive target replica may temporarily be at different whole-database versions. The migration must finish rewriting retained history into the target format before the target can become active.

## Ordered writer ranges

The storage key design must allow efficient logical iteration:

```text
records(author, afterExclusive, throughInclusive)
```

in ascending writer sequence order.

A conforming implementation must not require decoding/scanning every other writer merely to read one known writer suffix.

This local-index requirement does not by itself establish the end-to-end complexity theorem deferred to #1607.

## Canonical current record codec

For one database version, each journal record has one canonical persisted representation and meaning.

The codec must preserve exactly:

- record ID;
- event kind/body;
- causal frontier;
- authority time;
- NodeKey/NodeIdentifier/ValueId references;
- payload/timestamps;
- reasons/scopes/bases;
- writer-state fields.

For `ValidateEvent`, the current basis encoding is self-describing and canonical:

- each entry stores `{ input: NodeKey, value: ValueId | "unknown" }`;
- input NodeKeys are unique;
- entries are serialized by lexicographic canonical persisted `NodeKeyString` order as defined in the types spec, rather than graph-schema input order.

Therefore decoding/canonical comparison of a retained validation record does not require the historical graph schema merely to determine what its basis entries meant or whether their order is canonical.

Round-trip decode/encode must preserve semantic equality.

There is no normal mixed-version fallback path: bytes which are not valid for the replica's current `global/version` are malformed/incompatible state unless they are being read by the explicit source-version migration routine.

## Individual record sizing

Journal 3 does not impose the old compacted-journal asymptotic size bound.

A ValueEvent may legitimately contain a `ComputedValue` whose size is application-defined. Therefore an individual authoritative record may be proportional to its payload.

Implementations should still store events as individually addressable records rather than one monolithic ever-growing journal value, so suffix streaming/recovery does not require rewriting or loading the entire history.

## Atomic local publication

Local storage must provide a publication mechanism sufficient to make graph writes and finalized journal records durable atomically at the supported observation boundary.

For ordinary graph transactions, the logical effect is one atomic batch/publication.

For synchronization/reset/migration, inactive target construction plus atomic selected-target cutover is acceptable.

Journal 3 does not require all implementations/storage engines to expose identical fsync primitives; it requires the graph+journal atomicity contract defined elsewhere.

## Historical identity is immutable; migration may rewrite representation

Outside explicit database migration, a committed record key/ID is never updated with different representation or historical meaning.

Allowed ordinary physical operations include:

- read;
- copy/backup;
- derived index creation/deletion/rebuild.

A database-version migration is the controlled exception for representation evolution. It may rewrite every retained record body into the target version's canonical format, including adding/removing/changing representation fields, provided that for each pre-existing `(author,sequence)` it preserves the same historical semantic fact and every identity/reference relation.

The rewrite must be deterministic/canonical: independently migrating the same source-version record with the same source/target migration definition must produce the same target-version record. This is required so later same-ID overlap comparison does not manufacture a fork merely because two replicas migrated independently.

Representation migration does not append a semantic event merely because bytes changed. If the application/schema migration changes current graph semantics, those changes are represented separately by the migration baseline events defined in the migration spec.

## Whole-journal migration is permitted

A format-changing migration may stream across and rewrite the complete retained journal. Time and I/O proportional to retained journal length/serialized size are explicitly accepted by repository intent in exchange for the single-format invariant.

This does not require loading the complete journal in RAM; the rewrite should remain streamable where practical.

## No destructive replay-history GC

Base Journal 3 storage does not delete old authoritative historical facts merely because their current effect is summarized elsewhere.

A version migration may replace the source replica's old-format encoding with a target replica containing the same retained historical identities/facts in the new format. That is representation replacement, not history compaction.

A future archival tier may move physical storage if every retained historical record remains recoverable with its identity/meaning intact. Such archival protocol is outside the current core.

## Derived indexes

Useful optional derived local indexes include:

- retained writer frontier/head;
- record-by-node history index;
- current Value/Delete head per node;
- candidate Validate/Invalidate event indexes;
- reverse structural-edge index;
- cached authority high-water;
- replay checkpoint references.

Derived indexes must be rebuildable from authoritative records plus current schema where applicable.

A corrupted index does not authorize changing historical journal meaning.

## Source snapshots from local storage

When one local database is used as a `JournalSyncSource`, storage must provide a stable snapshot/immutable selected-replica handle satisfying `incremental-graph-journal-api.md`.

That snapshot must freeze together:

```text
global/version
global/graph_scheme
local writer identity
journal frontier
journal records through that frontier
```

All of those values must come from one committed selected replica state. It is not sufficient to read version/schema first and later open a journal snapshot which could refer to a post-migration/post-cutover replica.

The implementation may use native database snapshot semantics, an immutable selected-replica handle, or another mechanism which guarantees that all reads belong to one fixed committed state.

Journal 3 does not specify how an external transport such as Git packages or exposes an equivalent stable source snapshot. It specifies only the semantic requirement that an adapter expose compatibility metadata and journal content from one stable source cut.

## Startup validation

Local open may validate incrementally for performance, but before relying on a record/range as supported history it must enforce the current-version codec, contiguity, causal closure, and cross-record reference rules.

Cached derived validation results are allowed if invalidated correctly when new records arrive.
