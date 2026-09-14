# IncrementalGraph Journal 3 Reset

## Purpose

This document defines controlled reset of an existing Journal 3 database to the **projected graph state** of a chosen stable Journal 3 source.

Reset is not history replacement.

The receiver keeps its retained journal history, imports any missing source history, and then appends a causally later receiver-authored reset baseline whose projection has the requested source graph semantics.

There is no journal incarnation, history truncation, cursor invalidation, or replacement of the receiver stream.

## Semantic API

Conceptually:

```text
resetTo(source: JournalSyncSource) -> ResetResult
```

The source provides one fixed `JournalSnapshot` as defined by `incremental-graph-journal-api.md`.

The concrete outer lifecycle may identify that source by hostname, local snapshot, or another transport concept. Those transport identifiers are outside reset semantics.

## Preconditions

Reset requires:

- a valid writable Journal 3 receiver;
- a stable causally closed source snapshot;
- compatible current Journal 3/database/schema interpretation;
- exclusive maintenance ownership of the receiver;
- no conflicting record content for any overlapping `JournalRecordId`.

If the source contains a longer exact prefix of the receiver's own writer stream, reset first performs the same safe same-writer prefix recovery defined by synchronization. If overlapping same-writer content disagrees, reset fails rather than forking the writer history.

## Source target

Let:

```text
S = source journal snapshot
PS = project(S)
```

`PS` is the semantic graph target requested by reset.

The reset result need not use the source's current ValueIds or host-local allocator watermark. It must have an observationally equivalent IncrementalGraph projection for semantic nodes, values, timestamps, freshness, and validity, subject only to explicitly local allocator state.

## First retain the observed history

Let receiver history before reset be JR.

Reset first forms the same validated immutable union used by synchronization:

```text
J0 = union(JR, S)
```

All source records remain under their original writers.

The reset baseline is authored only after J0 is retained/observed conceptually, so every reset-authored semantic event is causally after the complete receiver+source frontier used to establish the target.

The operation still commits atomically: J0 is not exposed as an intermediate active receiver state if its projection is not the reset target.

## Why reset needs a new baseline

Simply taking `union(JR,S)` does not implement reset.

The receiver may contain a later/conflicting value for a node which wins normal authority over the source's current value. Reset intentionally requests the source projection anyway.

Therefore reset authors new local semantic events causally after both observed histories. Those events provide new authority for the selected reset result while preserving old competing events for replay/debugging.

## Reset semantic domain

Define:

```text
ResetDomain =
    semantic NodeKeys having any ValueEvent/DeleteEvent in J0
    union semantic NodeKeys present in PS
```

This includes receiver-only nodes which the source target does not materialize. They must not survive reset merely because the source never mentioned them.

Keys with only old historical events remain retained, but the reset baseline needs a new event only when required to make the selected post-reset head agree with PS.

## Pass 1: target value/absence heads

Reset establishes target heads for the complete reset domain before constructing validation certificates.

Process nodes in deterministic order, extending current structural input-before-dependent order where applicable.

### Source-present node

For every K present in PS, author a local:

```text
ValueEvent {
    node: K,
    nodeIdentifier: PS.nodeIdentifier(K),
    payload: PS.payload(K),
    createdAt: PS.createdAt(K),
    modifiedAt: PS.modifiedAt(K),
    reason: "reset"
}
```

The new event creates a new reset ValueId even when identical payload bytes already exist in receiver/source history.

Payload equality does not turn an old occurrence into the reset occurrence.

Using the source projection's selected NodeIdentifier is valid because NodeIdentifiers are globally fingerprint-namespaced physical identities and PS is required to be bijective.

### Source-absent node

For every K in ResetDomain absent in PS, author:

```text
DeleteEvent {
    node: K,
    reason: "reset"
}
```

when new absence authority is required to make the reset target selected.

An implementation may omit a redundant delete when the observed union already selects sufficiently causally/authoritatively later absence and no receiver-only current value can survive. Alternatively it may author one deterministic delete for every source-absent domain key, provided repeated already-satisfied reset can avoid unbounded duplicate no-op history.

## Pass 2: self-describing validation baselines

After every source-present node has its new reset ValueId, reset represents PS's exact validity relation with new reset certificates.

For source-present K let current target schema define:

```text
inputEdges(K) = [D0, D1, ...]
```

Author one:

```text
ValidateEvent {
    node: K,
    value: resetValueId(K),
    reason: "reset",
    basis: [
        {
            input: D0,
            value: resetValueId(D0) | "unknown"
        },
        ...
    ]
}
```

For each direct input D:

```text
basisEntry(D).value = resetValueId(D)
    if PS contains the legacy validity edge D -> K

basisEntry(D).value = "unknown"
    otherwise
```

Basis entry order follows current `inputEdges(K)` order, but each entry carries D explicitly so the historical reset certificate remains self-describing if a later migration changes input order/schema.

Because PS is dependency-closed, every direct input of a source-present K is also source-present and has a reset ValueId from Pass 1.

For a fresh target, ordinary IncrementalGraph invariants imply a complete exact-current basis.

For a stale target, the certificate exactly reproduces whichever incoming validity edges remain in PS without inventing missing historical provenance.

## Pass 3: persistent stale state

For every source-present K whose target freshness in PS is `"potentially-outdated"`, author after its reset validation:

```text
InvalidateEvent {
    node: K,
    scope: {
        kind: "value",
        value: resetValueId(K)
    },
    reason: "reset"
}
```

This keeps the reset cached occurrence stale while preserving exactly the incoming validity edges encoded by the reset certificate.

A fresh target receives no reset invalidation.

The reset validation is causally after all node-scoped invalidations in the histories reset observed, so the new baseline intentionally establishes the target's current proof state.

## Resulting projection

After baseline construction:

```text
Jreset = J0 + reset-authored records
Preset = project(Jreset)
```

The primary reset theorem is:

```text
semanticGraph(Preset) == semanticGraph(PS)
```

including:

- present semantic NodeKeys;
- exact ComputedValue payloads;
- exact createdAt/modifiedAt instants;
- freshness;
- semantic validity edges.

Current ValueIds normally differ because reset authors new value occurrences.

Receiver-local `last_node_index` remains receiver-local rather than adopting the source writer watermark.

## Allocation watermark

Reset does not reset the receiver's `last_node_index`.

Adopting source NodeIdentifiers from other writer namespaces does not consume the receiver's local numeric allocation namespace.

The local watermark remains at least its pre-reset/recovered same-writer value and advances only if reset performs a genuine local allocation which requires advancement.

A WriterStateRecord is authored only when the local durable watermark changes.

## Reset history and future synchronization

Old receiver events remain retained.

The reset baseline is causally after receiver/source history it observed, so reset-domain baseline heads dominate those observed competitors according to the causality-respecting authority rule.

An event from a third replica which reset did **not** observe remains concurrent. If learned later, ordinary Journal 3 conflict semantics apply.

Reset therefore means:

> establish this source projection as the new state relative to history currently observed

not:

> permanently defeat every event which may exist anywhere but has not been observed.

This satisfies no-remote-participation requirements without pretending reset knows unseen history.

## Same-writer restoration versus reset

If a receiver is merely missing an exact suffix of its own immutable writer history and no semantic replacement is requested, importing that suffix and replaying it is same-writer restoration. No reset baseline is needed.

`resetTo(source)` is for intentional semantic rebaselining to the source projection when ordinary retained-history conflict selection would otherwise produce another state.

## Repeat-reset idempotence

Repeated reset to an unchanged source from an unchanged already-equal receiver projection must not require an infinite sequence of redundant reset baselines.

If current semantic projection already equals the requested reset target and no reset-specific normalization is outstanding, reset may return `changed=false` without semantic records.

This target comparison is a reset/lifecycle decision; it does not let ordinary synchronization infer provenance/value identity from payload equality.

If a new baseline is required, physical payload bytes may be reused as an optimization, but each reset ValueEvent still has its own new ValueId.

## Atomicity

Reset may build J0/baseline/projection in inactive storage.

The receiver exposes either:

```text
old journal + old graph
```

or:

```text
Jreset + project(Jreset)
```

never a split/intermediate state.

Failure before cutover leaves the old supported receiver active.

## No computor invocation

Reset does not call computors.

Target payload/timestamps come from immutable source ValueEvent history through PS. Reset decisions are structural/historical.

A later ordinary pull may recompute stale reset nodes normally.

## Reset convergence interaction

Reset-authored records become ordinary immutable history.

Other replicas learn them through normal suffix synchronization; they do not need a special reset merge algorithm.

`reason="reset"` is historical/debugging metadata. Conflict/replay authority comes from ordinary event context/authority rules.
