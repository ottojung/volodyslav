# IncrementalGraph Journal 3 Reset

## Purpose

This document defines controlled reset of an existing Journal 3 database to the **projected graph state** of a chosen stable Journal 3 source.

Reset is not history replacement.

The receiver keeps retained history, imports missing source history, and appends only the receiver-authored semantic records required to make its projection observationally equal to the requested source projection.

There is no journal incarnation, history truncation, cursor invalidation, or replacement of the receiver stream.

## Reset is not pre-Journal bootstrap merge

Reset intentionally means “make this target state true after the history I have observed.” Its authored repair records are therefore causally after the complete source/receiver history used by reset.

That semantic MUST NOT be reused for the pre-Journal canonical-bootstrap join. A late legacy value may predate and be concurrent with a canonical bootstrap value even though migration code reads the canonical artifact later. Bootstrap conflict conversion is specified separately in `incremental-graph-journal-migrations.md`.

In particular, reset's target-absence deletion rule is not evidence that a legacy host's missing cache entry should delete a canonical bootstrap materialization.

## Semantic API

Conceptually:

```text
resetTo(source: JournalSyncSource) -> ResetResult
```

The source provides one fixed `JournalSnapshot` as defined by `incremental-graph-journal-api.md`.

The outer lifecycle may identify that source through any configured transport-neutral mechanism. Transport identifiers are outside reset semantics.

## Preconditions

Reset requires:

- a valid writable Journal 3 receiver;
- one stable causally closed source snapshot;
- exact compatibility between the source snapshot's `databaseVersion` / `graphSchemeString` and the receiver's active `global/version` / `global/graph_scheme`;
- exclusive maintenance ownership of the receiver;
- no conflicting content for overlapping `JournalRecordId`s.

Compatibility metadata must come from the same held `JournalSnapshot` used to derive the target and import source records.

If the source contains a longer exact prefix of the receiver's own writer stream, reset first performs the same safe same-writer recovery defined by synchronization. A divergent overlap is a hard fork.

An installation with no local database/writer identity uses the absent-state restoration lifecycle in `database-lifecycle.md`; `resetTo()` does not invent a local writer identity for an absent receiver.

## Source target

Let:

```text
S  = held compatible source JournalSnapshot
PS = project(S)
```

`PS` is the semantic graph target.

Reset targets observable IncrementalGraph semantics:

- presence;
- payload;
- NodeIdentifier;
- createdAt/modifiedAt;
- freshness;
- semantic validity edges.

It does not require the receiver to end with the same ValueIds as the source when a replacement occurrence must be authored locally.

## First retain the observed history

Let receiver history before reset be JR and define:

```text
J0 = union(JR, S)
P0 = project(J0)
```

All imported records retain their original writers.

Reset-authored events are causally after the complete observed J0 frontier. J0 is staging state and need not be exposed as active before reset finishes.

This causal-later rule is fundamental reset semantics, not a generic lifecycle-publication rule.

## Core identity rule

Reset distinguishes **value occurrence state** from proof/freshness state.

A new ValueEvent is required only when the selected current occurrence must be semantically replaced to reach PS.

Reset must not mint a new ValueId merely because:

- validation/proof differs;
- freshness differs;
- an input ValueId changed and a dependent needs a new certificate; or
- reset is being called again.

Those conditions are represented with ValidateEvent/InvalidateEvent as appropriate.

## Reset semantic domain

Define:

```text
ResetDomain =
    keys having any ValueEvent/DeleteEvent in J0
    union keys present in PS
```

Historical records outside the current source projection remain retained, but current selected state over this domain must become source-target-equivalent.

## Pass 1: establish target presence/value occurrences

Process ResetDomain in deterministic order.

### Target-present K

If P0 already contains K with the same observable immutable occurrence fields as PS:

```text
P0.nodeIdentifier(K) == PS.nodeIdentifier(K)
P0.payload(K)        == PS.payload(K)
P0.createdAt(K)      == PS.createdAt(K)
P0.modifiedAt(K)     == PS.modifiedAt(K)
```

then preserve the receiver-union selected occurrence:

```text
resetValueId(K) = P0.valueId(K)
```

and author no ValueEvent for K.

This semantic comparison is part of explicit reset targeting; it is not an ordinary synchronization inference of provenance from payload equality.

Otherwise author one causally-later local:

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

and define its ID as `resetValueId(K)`.

The new occurrence is required because J0 does not already select the requested semantic value state.

### Target-absent K

For every K absent in PS:

- if P0 already selects absence, author nothing;
- if P0 selects a ValueEvent, author exactly one:

```text
DeleteEvent {
    node: K,
    reason: "reset"
}
```

There is no alternative strategy. Repeated reset to the same absent target therefore does not accumulate redundant deletes.

Again, this is explicit reset targeting. It is not the rule for comparing two pre-Journal legacy caches during canonical bootstrap.

## Pass 2: establish target validity/proof

After Pass 1 every source-present node has a final target occurrence `resetValueId(K)`, either preserved or newly authored.

For each source-present K, evaluate the selected eligible certificate that would apply after Pass 1 under the current schema.

Reuse it only if it yields exactly PS's incoming validity relation for K and has the causal coverage required for PS's target freshness.

Otherwise author one:

```text
ValidateEvent {
    node: K,
    value: resetValueId(K),
    reason: "reset",
    basis: [
        {
            input: D,
            value: resetValueId(D) | "unknown"
        },
        ...
    ]
}
```

with exactly one canonical-order entry for every direct input D.

Use:

```text
resetValueId(D)
```

exactly when PS contains validity edge `D -> K`; otherwise use `"unknown"`.

This rule naturally repairs dependents whose own value occurrence was preserved but whose certificate would otherwise name an input ValueId replaced in Pass 1.

A new dependent ValueEvent is not needed merely to update that proof.

## Pass 3: establish target freshness

After Pass 2, compare replayed freshness with PS.

For target-fresh K, the selected certificate must make K fresh; if an old invalidation would prevent this, Pass 2 must have authored a causally later validation rather than replacing K's value occurrence solely for freshness.

For target-stale K, if replay is not already persistently stale as required, author:

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

Do not duplicate an already-uncovered current-value invalidation which already establishes the requested stale state.

Thus reset freshness changes are represented as freshness/proof history, not gratuitous value replacement.

## Resulting projection

Let:

```text
Jreset = J0 + reset-authored records
Preset = project(Jreset)
```

The reset theorem is:

```text
semanticGraph(Preset) == semanticGraph(PS)
```

for:

- present semantic NodeKeys;
- payloads;
- NodeIdentifiers;
- createdAt/modifiedAt;
- freshness;
- semantic validity edges.

ValueIds may differ only where reset had to create a new semantic value occurrence.

## Allocation watermark

Reset does not adopt the source writer's allocation watermark.

The receiver-local `last_node_index` remains local and monotone. Reusing source NodeIdentifiers already present in PS does not consume the receiver's local numeric namespace.

A WriterStateRecord is authored only when the receiver's own durable watermark genuinely changes.

## Reset history and future synchronization

Old receiver/source events remain retained.

Reset-authored records are causally after all history reset observed, so they establish the requested target relative to that observed history.

An unseen concurrent event from another replica remains concurrent and may affect a later ordinary synchronization.

Reset therefore means:

> establish this source projection relative to all history currently observed

not:

> permanently dominate every event that might exist elsewhere.

## Same-writer restoration versus reset

If a receiver only lacks an exact suffix of its own writer history, exact-prefix recovery is restoration. No reset baseline is needed.

`resetTo(source)` is for intentional semantic rebaselining when ordinary retained-history selection would otherwise produce another observable graph state.

## Repeat-reset idempotence

If `semanticGraph(P0) == semanticGraph(PS)` and there is no outstanding reset-specific repair obligation, reset returns:

```text
changed = false
```

and authors no semantic records.

Repeated reset therefore cannot create an unbounded chain of equivalent ValueEvents/ValidateEvents/Deletes.

## Atomicity

Reset may construct J0 and its repairs in inactive storage.

The receiver exposes either:

```text
old journal + old graph
```

or:

```text
Jreset + project(Jreset)
```

never a split/intermediate state.

Failure before cutover leaves the previous supported receiver active.

## No computor invocation

Reset does not invoke computors.

Target payload/timestamps come from PS and immutable retained ValueEvents. A later ordinary pull may recompute stale reset nodes normally.

## Reset convergence interaction

Reset-authored records are ordinary immutable history after commit.

Other replicas learn them through normal suffix synchronization; no special reset merge algorithm exists.

`reason="reset"` is historical/debug metadata. Replay authority comes from normal event identity, context, authority, and certificate rules.
