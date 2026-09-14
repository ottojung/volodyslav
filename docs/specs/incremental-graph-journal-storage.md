# IncrementalGraph Journal 3 Local Storage Requirements

## Purpose

This document specifies storage properties required by Journal 3 without choosing a concrete backend/remote product, changing an existing transport protocol, or prescribing exact LevelDB key names.

The current implementation is expected to use new local database sublevels consistent with the intent that existing graph sublevel representations remain unchanged during Journal 3 work.

## Required logical collections

A conforming local implementation must persist enough information to recover:

- every immutable journal record by `JournalRecordId`;
- ordered per-writer range iteration;
- the retained frontier (either explicitly or derivably);
- current local writer identity;
- any derived indexes chosen for performance.

Only immutable journal records are authoritative.

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

## Ordered writer ranges

The storage key design must allow efficient logical iteration:

```text
records(author, afterExclusive, throughInclusive)
```

in ascending writer sequence order.

A conforming implementation must not require decoding/scanning every other writer merely to read one known writer suffix.

This local-index requirement does not by itself establish the end-to-end complexity theorem deferred to #1607.

## Canonical record codec

Each immutable record has one canonical persisted meaning selected by `recordVersion`.

The codec must preserve exactly:

- record ID;
- record version;
- event kind/body;
- causal frontier;
- authority time;
- NodeKey/NodeIdentifier/ValueId references;
- payload/timestamps;
- reasons/scopes/bases;
- writer-state fields.

For `ValidateEvent`, v1 basis encoding is self-describing and canonical:

- each entry stores `{ input: NodeKey, value: ValueId | "unknown" }`;
- input NodeKeys are unique;
- entries are serialized in canonical semantic NodeKey order rather than graph-schema input order.

Therefore decoding/canonical comparison of a historical validation record does not require the historical graph schema merely to determine what its basis entries meant or whether their order is canonical.

Round-trip decode/encode must preserve semantic equality.

If multiple byte encodings are technically accepted for one old version, fork comparison uses canonical decoded meaning, not accidental byte spelling, unless that version explicitly defines byte identity as semantic.

## Individual record sizing

Journal 3 does not impose the old compacted-journal asymptotic size bound.

A ValueEvent may legitimately contain a `ComputedValue` whose size is application-defined. Therefore an individual authoritative record may be proportional to its payload.

Implementations should still store events as individually addressable records rather than one monolithic ever-growing journal value, so suffix streaming/recovery does not require rewriting or loading the entire history.

## Atomic local publication

Local storage must provide a publication mechanism sufficient to make graph writes and finalized journal records durable atomically at the supported observation boundary.

For ordinary graph transactions, the logical effect is one atomic batch/publication.

For synchronization/reset/migration, inactive target construction plus atomic selected-target cutover is acceptable.

Journal 3 does not require all implementations/storage engines to expose identical fsync primitives; it requires the graph+journal atomicity contract defined elsewhere.

## Immutable records after commit

A committed record key/ID is never updated with different historical meaning.

Allowed physical operations include:

- read;
- copy/backup;
- re-encoding through a lossless storage migration which preserves the same logical record identity/meaning;
- derived index creation/deletion/rebuild.

A storage migration which changes physical bytes without changing logical JournalRecord meaning is not a semantic Journal 3 event.

## No destructive replay-history GC

Base Journal 3 storage does not delete old authoritative records merely because their current effect is summarized elsewhere.

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

A corrupted index does not authorize changing immutable history.

## Source snapshots from local storage

When one local database is used as a `JournalSyncSource`, storage must provide a stable snapshot/immutable prefix handle satisfying `incremental-graph-journal-api.md`.

The implementation may use native database snapshot semantics or another mechanism which guarantees that all reads belong to one fixed frontier.

Journal 3 does not specify how an external transport such as Git packages or exposes an equivalent stable source snapshot.

## Startup validation

Local open may validate incrementally for performance, but before relying on a record/range as supported history it must enforce the relevant codec, contiguity, causal closure, and cross-record reference rules.

Cached derived validation results are allowed if invalidated correctly when new records arrive.
