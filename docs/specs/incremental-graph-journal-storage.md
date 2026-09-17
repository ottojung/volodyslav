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

## Immutable same-version record identity

Outside explicit database-format migration, committed `(author,sequence)` meaning is immutable.

Same-ID body disagreement is a fork. Representation migration is permitted only when it deterministically preserves JournalRecordId, historical semantic fact, causal/reference meaning, and writer coordinates.

## Total whole-history format rewrite

A source->target Journal format migration defines a deterministic target representation for **every retained source-format record**, not merely records whose node families remain in target schema.

Historical ValueEvents, validation-basis NodeKeys, invalidations, and other records for target-removed families remain retained and require deterministic target encodings. If the transform is not total over retained source history, that migration is unsupported before cutover.

When payload representation changes, one pure per-record codec rewrites every affected retained ValueEvent independent of:

- selected/non-selected status;
- target current-schema membership;
- replica-local mutable state;
- callback traversal; or
- which other records the replica retains.

Thus two replicas retaining one historical ID produce the same target-format body.

## No Journal-aware value-producing `override()`

Once Journal history exists, the canonical codec is the sole source of representation-only target bytes.

A selected occurrence whose semantic meaning survives uses `keep`. Journal-aware execution rejects the legacy `override(nodeIdentifier,value)` path rather than evaluating a second replica-local representation transform.

The legacy override API remains relevant only to pre-Journal migrations whose source has no Journal history.

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

## Safe local writer continuation

A stored writer head is safe for continued local allocation only when lifecycle invariants establish that it is complete for that continuing writer.

A generic peer `JournalSnapshot` is not sufficient continuation authority merely because it contains a longer agreeing local-writer prefix.

The configured `InstallationRecoverySource` supplies the stronger continuation-safe contract used by absent restore and existing-writer recovery. If that source cannot establish that the recovered head is the greatest durable local-writer coordinate capable of later re-entering supported history, continuation remains indeterminate and no new local record may be allocated.

After authoritative recovery, storage reconstructs at least:

- local Journal head;
- `last_node_index`;
- authority high-water;
- projection; and
- required derived indexes.

## Canonical bootstrap artifact

`CanonicalBootstrapSnapshot` is lifecycle source state, not an active JournalReplica. It contains exactly the original bootstrap cut/version/schema and no later records.

The artifact is immutable while a release claims support for that bootstrap target. A later current `JournalSnapshot` containing the bootstrap prefix is not equivalent.

Creator-resume installs exactly artifact history only after direct persisted-legacy equality validation.

Ordinary joining retains the canonical cut verbatim and may add joining-writer historical values, `proof(V,D)` barriers for exact-shared canonical proof edges missing on the joining side, `value(V)` stale markers, and local WriterState history.

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
- continuation-safe recovery authority.

Transport implementation of these abstractions is outside Journal semantics.

## Startup validation

Before history is trusted, storage/open validates current-format decoding, stream contiguity, exact own-prefix contexts, transitive closure, authority extension, ValueId reference causality, canonical validation bases/scopes, local allocator consistency, and Journal/projection equality or successful rebuild.

Malformed authoritative history is rejected rather than repaired from mutable graph bytes.

## No destructive replay-history GC

Journal 3 does not destructively delete authoritative old records merely because their current effect can be summarized. Format replacement of the same historical records during version migration is not semantic compaction.
