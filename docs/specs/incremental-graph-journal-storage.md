# IncrementalGraph Journal 3 Local Storage Requirements

## Purpose

This document specifies local storage properties required by Journal 3 without choosing a remote/backend product, changing transport behavior, or prescribing exact LevelDB key names.

Existing IncrementalGraph sublevel formats remain unchanged; Journal-specific state lives in new namespaces.

## Required logical state

A conforming implementation can recover:

- every retained Journal record by `JournalRecordId`;
- ordered per-writer ranges/frontiers;
- current local writer identity;
- `global/version` and `global/graph_scheme`;
- the matching materialized graph projection;
- local writer allocator/high-water state; and
- optional rebuildable indexes/checkpoints.

Journal records are authoritative semantic history. Derived indexes/frontier caches are not.

## One current format per active replica

`global/version` selects the complete active representation, including Journal records. Journal records have no independent version tag.

A format migration builds a homogeneous target representation and cuts over only after all retained records have deterministic target encodings and target replay validates.

## Ordered writer ranges

Storage supports efficient logical iteration:

```text
records(author, afterExclusive, throughInclusive)
```

without scanning unrelated writers.

## Canonical record codec

For one current version each record has one canonical representation/meaning.

ValidateEvent bases are self-describing and canonical-order:

```text
{ input: NodeKey, value: ValueId | "unknown" }
```

Invalidate scopes encode distinctly:

```text
{ kind: "node" }
{ kind: "value", value: ValueId }
{ kind: "proof", value: ValueId, input: NodeKey }
```

Storage must not collapse these scopes.

## Causal validation support

For semantic `F=(W,q)`:

```text
F.context[W] == q - 1
```

and every included semantic E satisfies:

```text
E.context <= F.context
```

componentwise. Merely checking coordinates are within retained frontier is insufficient.

The narrow historical bootstrap-value exception may omit canonical foreign coordinates, but its stored context remains closed over every coordinate it claims.

## Atomic local publication

Ordinary graph transition and finalized Journal history become durable atomically. Large maintenance operations may build inactive state and atomically switch the active pair.

No supported state exposes new Journal with old graph or old Journal with new graph.

## Lifecycle-owned local persistence

While the local database exists, its authoritative persisted state changes only through supported Volodyslav lifecycle transitions. Local writer head and allocator state do not decrease through such transitions.

Complete disappearance of the local database is supported and yields the lifecycle `Absent` state. Partial Journal truncation, rollback to an older database image, mixed old/new storage, partial restoration, or direct external mutation are unsupported/corrupt storage states rather than inputs to a semantic repair algorithm.

## Immutable same-version record identity

Outside explicit database-format migration, committed `(author,sequence)` meaning is immutable.

Same-ID body disagreement is a fork. Representation migration is permitted only when it deterministically preserves JournalRecordId, historical semantic fact, causal/reference meaning, and writer coordinates.

## Total whole-history format rewrite

The normative source->target `JournalFormatCodec` contract and rewrite pipeline are defined in `migration.md` §Journal format codec.

Storage must support applying that pipeline to **every retained source-format record**, not merely records whose node families remain in target schema. This includes non-selected ValueEvents, historical validation-basis NodeKeys, proof-scope input NodeKeys, and history for target-removed families.

The rewrite decodes the source record, applies the transition's pure NodeKey/value transforms, re-canonicalizes target structures, and encodes the target current format while preserving Journal identity and historical meaning. In particular, ValidationBasis entries are re-sorted by the target canonical persisted NodeKeyString order after NodeKey rewriting.

The source->target codec definition must guarantee `rewriteNodeKey` injectivity over the complete supported source NodeKey semantic domain, not merely over keys retained by this storage instance. Storage/migration code should additionally reject any collision it observes among local retained keys as a defensive `JournalVersionCompatibilityError`, but that local scan does not establish the distributed codec property.

If the codec cannot produce a deterministic valid target semantic record for any retained source record, migration fails `JournalVersionCompatibilityError` before cutover.

Thus two replicas retaining one historical ID and applying the same version transition produce the same target-format body.

A selected occurrence whose semantic meaning survives uses `keep`; the canonical whole-history codec is the only representation-rewrite mechanism.

## Maintenance proof-edge records

When bootstrap/reset/migration preserves occurrence V but intentionally removes incoming validity edge `D -> K`, it may persist:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "proof", value: V, input: D },
    reason: "bootstrap" | "reset" | "migration"
}
```

This is authoritative semantic history, not derived metadata.

Replay treats the barrier as negative evidence only for `(V,D)`. It does not invalidate the whole certificate, unrelated inputs, or another ValueId V2.

Multiple barriers accumulate by removing the union of named edges from effective proof.

True explicit `invalidate(K)` remains node-scoped.

## Persistent stale records

When graph/lifecycle semantics persist K stale while K's own effective proof is otherwise complete, retained history contains an uncovered:

```text
Invalidate(K, scope=value(currentValueId(K)), reason=...)
```

This requirement covers ordinary propagation, synchronization, bootstrap, reset, and migration. It prevents later upstream `Unchanged` from silently erasing a stored stale transition.

## Established local writer monotonicity and absent restoration

For an existing supported database, the local writer head and `last_node_index` are monotone. A generic peer `JournalSnapshot` containing a longer agreeing prefix of the local writer is therefore evidence of unsupported existing-state rollback and causes `JournalWriterBehindError`; it is not a source for repairing that existing database.

When the complete local database is absent, restoration may use `InstallationRecoverySource`. For writer A restored at head q, the returned snapshot must be continuation-safe: after restore no previously-authored A record with sequence greater than q may later enter supported retained history and collide with new allocation.

After absent restoration, storage reconstructs at least:

- local Journal head;
- `last_node_index`;
- authority high-water;
- projection; and
- required derived indexes.

## Canonical bootstrap artifact

`CanonicalBootstrapSnapshot` is lifecycle source state, not an active JournalReplica. It contains exactly the original bootstrap cut/version/schema and no later records.

The artifact is immutable while a release claims support for that bootstrap target. A later current `JournalSnapshot` containing the bootstrap prefix is not equivalent.

Creator-resume installs exactly artifact history only after direct persisted-legacy equality validation.

Ordinary joining retains the canonical cut verbatim and may add joining-writer historical values, truthful locally-authored validation bases naming the joining host's own legacy input occurrences, `proof(V,D)` barriers for exact-shared canonical proof edges missing on the joining side, `value(V)` stale markers, and local WriterState history.

Legacy absence does not manufacture DeleteEvent. Joining historical values may use the controlled non-causal bootstrap context rule and legacy `modifiedAt` authority.

## Existing graph sublevels remain projection

Journal provenance, causal metadata, proof barriers, and synchronization state are not embedded into existing `values`, `freshness`, `valid`, `timestamps`, or identifier formats. Replay lowers semantic state into those existing representations.

## Derived indexes

Optional rebuildable indexes may include:

- per-writer heads/frontiers;
- node history;
- candidate head/certificate/invalidation indexes;
- reverse structural edges;
- authority high-water;
- context-closure summaries; and
- replay checkpoint references.

They never become independent authority.

## Stable local snapshots

A local `JournalSyncSource` supplies one immutable committed state containing exact version/schema, localWriter, frontier, and corresponding records.

That ordinary snapshot is distinct from both:

- `CanonicalBootstrapSnapshot`; and
- a continuation-safe snapshot supplied for complete-absence restoration.

Transport implementation of these abstractions is outside Journal semantics.

## Startup validation

Before history is trusted, storage/open validates current-format decoding, stream contiguity, exact own-prefix contexts, transitive closure, authority extension, ValueId reference causality, canonical validation bases/scopes, local allocator consistency, and Journal/projection equality or successful rebuild.

Malformed authoritative history is rejected rather than repaired from mutable graph bytes.

## No destructive replay-history GC

Journal 3 does not destructively delete authoritative old records merely because their current effect can be summarized. Format replacement of the same historical records during version migration is not semantic compaction.
