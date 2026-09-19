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

The shared own-writer rollback condition is defined by `incremental-graph-journal-lifecycle.md` §5. If the held source snapshot is ahead for the receiver's own writer, `resetTo()` fails `JournalWriterBehindError` before import/authorship and leaves the active receiver unchanged. Divergent overlap remains `JournalForkError`.

An installation with no local database/writer identity uses the absent-state restoration lifecycle in `incremental-graph-journal-lifecycle.md`; `resetTo()` does not invent a local writer identity for an absent receiver.

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
H0 = selectedHeads(J0)
```

where `selectedHeads` is the raw maintenance view defined by `incremental-graph-journal-replay.md` §Raw selected-head view.

Do **not** call `project(J0)` here. Two individually valid dependency-closed replicas may have a compatible union whose cross-authority Value/Delete winners are not dependency-closed. Reset must be able to repair that staging state rather than reject before Pass 1.

All imported records retain their original writers.

Reset-authored events are causally after the complete observed J0 frontier. J0 and H0 are staging state and need not be exposed as active before reset finishes.

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

If H0 selects a ValueEvent for K with the same observable immutable occurrence fields as PS:

```text
H0.nodeIdentifier(K) == PS.nodeIdentifier(K)
H0.payload(K)        == PS.payload(K)
H0.createdAt(K)      == PS.createdAt(K)
H0.modifiedAt(K)     == PS.modifiedAt(K)
```

then preserve the receiver-union selected occurrence:

```text
resetValueId(K) = H0.valueId(K)
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

The new occurrence is required because H0 does not already select the requested semantic value state.

### Target-absent K

For every K absent in PS:

- if H0 selects DeleteEvent or has no semantic head, author nothing;
- if H0 selects a ValueEvent, author exactly one:

```text
DeleteEvent {
    node: K,
    reason: "reset"
}
```

There is no alternative strategy. Repeated reset to the same absent target therefore does not accumulate redundant deletes.

Again, this is explicit reset targeting. It is not the rule for comparing two pre-Journal legacy caches during canonical bootstrap.

## Pass 1 closure guarantee

Let `J1` be J0 plus the Pass 1 ValueEvents/Deletes.

Because every reset-authored Pass 1 head is causally later than the complete J0 frontier:

- every K present in PS has a selected ValueEvent in J1 whose immutable occurrence fields equal PS;
- every K absent in PS has no selected ValueEvent in J1;
- therefore selected presence in J1 is exactly selected presence in PS.

PS is a valid source projection and is dependency-closed under the current schema. Hence J1's selected-present head set is dependency-closed as well. Its selected NodeIdentifiers/immutable occurrence state also match PS for every present node.

Only now is the projection defined:

```text
P1 = project(J1)
```

A conforming implementation computes the required P1 state as a delta over the reset-affected closure using retained projection/index state, observationally equal to `project(J1)`. It does not replay or revalidate unrelated retained history; reset validation remains O(C) with respect to Journal history under `$id-6845129073418625`.

Failure while validating the newly admitted/authored records or affected closure means an invariant other than the pre-repair dependency-closure mix remains invalid; reset does not treat such corruption as a repair opportunity.

## Pass 2: establish target validity/proof

After Pass 1 every source-present node has a final target occurrence `resetValueId(K)`, either preserved or newly authored.

For each source-present K define:

```text
PotentialValid(K) =
    eligibleEffectiveProofUnion_P1(K)

TargetValid(K) = {
    D | PS contains semantic validity edge D -> K
}
```

### Proof weakening uses occurrence-and-input barriers

Replay intentionally prefers certificates with greater effective basis applicability before authority. Therefore merely appending a later certificate with more `"unknown"` entries cannot by itself remove validity supplied by older proof.

For every incoming edge that **any eligible retained certificate** for the preserved occurrence can currently prove, but the reset target must not expose:

```text
D in PotentialValid(K) - TargetValid(K)
```

reset MUST author one barrier:

```text
InvalidateEvent {
    node: K,
    scope: {
        kind: "proof",
        value: resetValueId(K),
        input: D
    },
    reason: "reset"
}
```

Call this a **reset proof-edge barrier**.

A proof-edge barrier retires the exact incoming edge `D -> K` for the exact preserved occurrence. A certificate can re-establish that edge only if it causally observes the barrier and explicitly proves D again. The barrier does not invalidate the certificate's unrelated basis entries, so independent reset/migration operations on the same ValueId can compose by accumulating the edges each one intentionally removed.

The barrier is occurrence-scoped on purpose. Reset is weakening proof for the preserved occurrence; it is not semantically issuing an explicit node invalidation which should taint certificates for an unseen concurrent/later replacement ValueId.

The barrier set is computed from the fixed P1 cut **before** authoring any reset proof barriers. Because it covers every effective unwanted edge of every certificate eligible at P1, weakening one certificate cannot reveal an unwanted edge from a previously losing certificate. Proof barriers do not make an ineligible historical certificate eligible, and every reset-authored target validation is causally after the new barriers, so one pass over `PotentialValid(K) - TargetValid(K)` is complete; no iterative barrier-discovery loop is required.

This does not combine positive proof from multiple certificates. `PotentialValid` is used only to choose negative barriers. Replay continues to obtain all positive validity edges from exactly one selected certificate.

The barrier is required only for proof weakening/removal. If reset merely adds validity edges, the later stronger certificate naturally wins by effective basis-match count and no barrier is needed solely for that addition.

After any required barriers, evaluate replay under the current schema.

Reuse the selected certificate only if replay already yields exactly `TargetValid(K)` and has the causal coverage required for PS's target freshness.

Otherwise author one causally-later:

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

exactly when D is in `TargetValid(K)`; otherwise use `"unknown"`.

When proof-edge barriers were authored, this validation occurs after them and may re-establish only the edges represented by matching ValueIds in its basis. An all-`"unknown"` target certificate therefore represents zero incoming target validity without an old full certificate reintroducing an edge that maintenance retired.

This rule also repairs dependents whose own value occurrence was preserved but whose certificate would otherwise name an input ValueId replaced in Pass 1.

A new dependent ValueEvent is not needed merely to update or weaken proof.

## Pass 3: establish target freshness

After Pass 2, let `P2 = project(J2)` denote the resulting projection state needed for the affected reset closure. Implementations obtain that affected state incrementally from retained projection/index state rather than replaying unrelated retained history (`$id-6845129073418625`).

Use `selfProofReady(K)` as defined in `incremental-graph-journal-replay.md` §Persistent propagated staleness, evaluated at this pass's replay cut.

Node-scoped invalidations affect certificate eligibility; proof-edge barriers affect the effective basis edge-by-edge. Thus `selfProofReady(K)` means K is not persistently stale because of its own proof deficiency, explicit node invalidation, proof-edge deficit, or current-value invalidation. It may nevertheless be recursively stale because a direct input is stale.

For target-fresh K, final replay must make K fresh. If an observed invalidation prevents that, Pass 2 must establish a causally later complete validation rather than replacing K's value occurrence solely for freshness.

For target-stale K:

- if an uncovered value-scoped invalidation already targets `resetValueId(K)`, do not duplicate it;
- otherwise, if `selfProofReady(K)` is true, author:

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

This rule applies even when P2 already reports K stale **solely because a direct input is stale**. Recursive staleness at the reset cut is not itself a persistent marker. Without the value-scoped event, a later `Unchanged` revalidation of the input could incorrectly make K fresh even though the reset target's stored stale flag must remain stale until K itself validates/recomputes.

If `selfProofReady(K)` is false, K already has a persistent own-state reason for staleness such as basis mismatch, an uncovered node invalidation, an effective proof-edge deficit, or an uncovered current-value invalidation; no additional marker is required merely to duplicate that reason.

Thus reset freshness changes are represented as persistent freshness/proof history, not gratuitous value replacement.

## Streamability

Reset's Journal/replay processing MUST satisfy `$id-4924739474925738`.

Pass 1 domain traversal, Pass 2 eligible-certificate/`PotentialValid(K)` evaluation, and Pass 3 freshness propagation must be implementable as ordered/indexed iteration with bounded iterator/runtime buffers. Journal-derived worklists or changed-node/closure sets may use durable/indexed staging or an equivalent bounded-memory queue, but reset MUST NOT require the complete retained Journal, complete reset domain, complete eligible-certificate population, or complete changed-node/propagation closure to be materialized in RAM as one collection.

`PotentialValid(K)` is computed per node by streaming/folding that node's eligible certificate and invalidation history; the declarative union does not imply a global in-memory set.

As with synchronization, graph-sized derived graph/index state independently required by IncrementalGraph correctness is allowed, and graph-sized whole-replica **non-validation** work may still occur where correctness requires it. Historical validation/replay attributable to reset remains bounded by newly admitted/affected state C under `$id-6845129073418625`; unrelated retained Journal history is not rescanned. This is compatible with the deferred end-to-end running-time work in `$id-3572255392439745`, because that deferral does not permit history-wide revalidation.

## Resulting projection

Let, denotationally:

```text
Jreset = J0 + reset-authored records
Preset = project(Jreset)
```

The implementation reaches this projection by applying/validating the reset delta over the affected closure and maintained indexes; the equality does not require a whole-history replay during reset.

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

The equivalence is stable under later ordinary `Unchanged` revalidation of an upstream input: a dependent which reset established as persistently stale does not become fresh unless that dependent itself later validates/recomputes.

## Allocation watermark

Reset does not adopt the source writer's allocation watermark.

The receiver-local `last_node_index` remains local and monotone. Reusing source NodeIdentifiers already present in PS does not consume the receiver's local numeric namespace.

A WriterStateRecord is authored only when the receiver's own durable watermark genuinely changes.

## Reset history and future synchronization

Old receiver/source events remain retained.

Reset-authored records are causally after all history reset observed, so they establish the requested target relative to that observed history.

An unseen concurrent event from another replica remains concurrent and may affect a later ordinary synchronization.

A reset proof-edge barrier affects only one input edge of one ValueId. It does not invalidate unrelated proof on that occurrence and does not taint certificates for another replacement occurrence merely because it shares the same NodeKey.

Reset therefore means:

> establish this source projection relative to all history currently observed

not:

> permanently dominate every event that might exist elsewhere.

## Own-writer rollback boundary

Reset uses the shared boundary in `incremental-graph-journal-lifecycle.md` §5; no additional reset-specific recovery semantics exist.

## Repeat-reset idempotence

Reset returns:

```text
changed = false
```

exactly when the source snapshot frontier is already covered by the receiver's retained Journal (so reset imports no source record) **and** Passes 1–3 author no semantic records. Otherwise reset returns `changed = true`.

Thus `changed` describes whether reset publishes any persistent Journal/database change, not merely whether the receiver authors a new semantic record.

After one successful reset, every pre-reset eligible certificate is already barriered on every non-target edge it could expose, and any reset-authored target certificate is causally after those barriers and proves only target edges. Therefore a second reset to the unchanged source computes no new unwanted edge in `PotentialValid - TargetValid`; if the selected certificate already has the required target proof/freshness coverage, it authors no barrier or validation.

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