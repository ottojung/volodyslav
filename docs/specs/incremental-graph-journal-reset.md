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

The reset result is not required to have the same journal IDs as S or the same host-local allocator watermark. It must have an observationally equivalent IncrementalGraph projection for semantic nodes, values, timestamps, freshness, and validity, subject only to explicitly local allocator state.

## First retain the observed history

Let receiver history before reset be `JR`.

Reset first forms the same validated immutable union used by synchronization:

```text
J0 = union(JR, S)
```

All source records remain under their original writers.

The reset baseline is authored only after J0 is retained/observed conceptually, so every reset-authored semantic event is causally after the complete receiver+source frontier used to establish the target.

The final operation still commits atomically: J0 is not exposed as an intermediate active receiver state if its projection is not the reset target.

## Why reset needs a new baseline

Simply taking `union(JR,S)` does not implement reset.

The receiver may contain a later/conflicting value for a node which wins normal authority over the source's current value. Reset intentionally requests the source projection anyway.

Therefore reset authors new local semantic events causally after both observed histories. Those events provide new authority for the selected reset result while preserving the old competing events for replay/debugging.

## Reset semantic domain

Define:

```text
ResetDomain =
    semantic NodeKeys having any ValueEvent/DeleteEvent in J0
    union semantic NodeKeys present in PS
```

This domain includes receiver-only nodes which the source target does not materialize. They must not survive reset merely because the source never mentioned them.

Keys with only old historical events still belong to the retained history, but the reset baseline needs a new event only when required to make the selected post-reset head agree with PS.

## Pass 1: value/absence heads

Reset first establishes target heads for the complete reset domain before constructing validation bases.

Process semantic nodes in deterministic canonical order, with structural input-before-dependent order where dependency ordering is applicable.

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

The new event creates a new reset `ValueId` even when identical payload bytes already exist in receiver or source history.

Payload equality is not used to claim that an older occurrence has become the reset occurrence.

Using the source projection's selected `NodeIdentifier` is valid because NodeIdentifiers are globally fingerprint-namespaced physical identities and the source projection is required to be bijective. A later ordinary local recomputation may continue carrying that identifier exactly as it would after ordinary synchronization selected a foreign occurrence.

### Source-absent node

For every K in `ResetDomain` which is absent in PS, author a local:

```text
DeleteEvent {
    node: K,
    reason: "reset"
}
```

when a new delete is required to make the reset-authored baseline's selected head absent.

It is permissible to omit a redundant new delete when the already-observed union has a selected delete causally/authoritatively sufficient to keep K absent and omitting the event cannot make the reset result depend on a receiver-only current value. Implementations may instead author one deterministic delete for every source-absent domain key; both approaches are semantically valid if repeat reset can avoid unbounded duplicate no-op history as required below.

## Pass 2: validation baselines

After every source-present node has its newly allocated reset `ValueId`, reset can represent the source target's exact legacy validity relation using those new IDs.

For source-present K let:

```text
inputEdges(K) = [D0, D1, ...]
```

Construct one `ValidateEvent(reason="reset")` targeting K's new reset ValueId.

For each direct input position i:

```text
basis[i] = resetValueId(Di)
    if PS contains the legacy validity edge Di -> K

basis[i] = "unknown"
    otherwise
```

Because PS is dependency-closed, every direct input Di of a present K is also source-present and therefore has a reset ValueId from Pass 1.

For a fresh target node, the existing IncrementalGraph invariant guarantees a complete basis of current reset ValueIds.

For a stale target node, the basis exactly reproduces whichever incoming validity edges remain in PS without inventing provenance for missing edges.

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

A fresh target receives no such invalidation.

This value-scoped rule is sufficient because the reset validation/baseline is causally after all node-scoped invalidations in the histories reset actually observed. The new baseline intentionally establishes the target's current proof state rather than preserving old invalidation frontiers as separate compacted authority.

## Resulting projection

After the reset baseline is complete, define:

```text
Jreset = J0 + reset-authored records
Preset = project(Jreset)
```

The primary reset law is:

```text
semanticGraph(Preset) == semanticGraph(PS)
```

including:

- present semantic NodeKeys;
- exact `ComputedValue` payloads;
- exact `createdAt` / `modifiedAt` instants;
- freshness;
- semantic validity edges.

Current `ValueId`s are expected to differ because reset authors new value occurrences.

Host-local receiver allocation state (`last_node_index`) remains receiver-local. It is not replaced by the source's writer watermark.

## Allocation watermark

Reset does not reset the receiver's `last_node_index`.

If reset adopts source `NodeIdentifier`s belonging to other writer namespaces, those identifiers do not consume the receiver's local numeric allocation namespace.

The receiver's local watermark therefore remains at least its pre-reset/recovered same-writer watermark and advances only if reset itself performs a genuine local allocation requiring that advancement.

A `WriterStateRecord` is authored only when the local watermark actually changes.

## Reset history and future synchronization

Old receiver events remain retained.

The reset baseline is causally after the receiver/source history it observed, so for every reset-domain node it dominates those observed competing heads according to the causal-authority requirement.

An event from some third replica which reset did **not** observe remains concurrent with the reset baseline. If learned later, ordinary Journal 3 conflict authority determines the result.

Reset therefore means:

> establish this source projection as the new state relative to the history currently observed

not:

> permanently defeat every event which may exist anywhere but has not been observed.

This is necessary to satisfy the no-remote-participation requirement without pretending the receiver knows absent hosts' future/unseen history.

## Same-writer restoration versus reset

Journal 3 has a much smaller distinction than Journal 2.

If a receiver is merely missing a suffix of its own immutable writer history and no semantic replacement is requested, importing that exact suffix and replaying it is **same-writer restoration**. No reset baseline is required.

`resetTo(source)` is used when the caller intentionally requests the source's projected graph state even though the receiver's current observed history may otherwise select different semantics.

Thus restoration is prefix recovery; reset is semantic rebaselining.

## Repeat-reset idempotence

Repeated reset to an unchanged source from an unchanged receiver projection must not require an infinite sequence of semantically redundant reset baselines.

Before authoring a new baseline, an implementation may compare the current receiver projection against the requested source target using structured Journal/graph identity and projection fields.

If the current semantic graph is already exactly the reset target and there is no outstanding reset-specific normalization obligation, reset may return `changed=false` without authoring semantic records.

This equality check is a reset/lifecycle target comparison. It does not permit ordinary synchronization to use payload equality as provenance or value identity.

If a baseline is required, it may still reuse payload bytes physically as an implementation optimization, but the new `ValueEvent` carries a new reset `ValueId`.

## Atomicity

Reset may construct J0, the baseline, and the matching graph in inactive storage.

The receiver exposes either:

```text
old journal + old graph
```

or:

```text
Jreset + Preset
```

never an intermediate split state.

Failure before cutover leaves the old supported receiver active.

## No computor invocation

Reset does not call computors.

Every target payload and timestamp is copied from immutable source `ValueEvent` history through the source projection. Every reset decision is structural/historical.

A later ordinary `pull()` may recompute stale reset nodes according to the normal graph contract.

## Reset convergence interaction

Reset-authored records are ordinary immutable journal history after commit.

Other replicas learn them through normal suffix synchronization. They do not need a special "this was reset" merge algorithm.

The `reason="reset"` tag is historical/debugging information; conflict/replay authority comes from the ordinary event context and authority rules.
