# IncrementalGraph Journal 2 Projection

## Purpose

This specification defines how Journal 2 metadata and the unchanged legacy payload sublevels determine the observable IncrementalGraph materialization.

Journal 2 does not replace `values`, `freshness`, `timestamps`, `valid`, or `identifiers_keys_map`. Instead, supported persisted state must satisfy the projection invariants below.

## Semantic address and current value

For a `NodeKey K`, let `S[K]` be its `NodeJournalSummary`.

If `S[K].head.kind == "absent"`, K must be unmaterialized in the legacy graph.

If `S[K].head.kind == "present"`, K must be materialized and the legacy value/timestamp record must be the record associated with `S[K].head.value.id` under the supported lifecycle.

The current `ValueRef` carries immutable origin `context` and `authorityTime`; those are journal metadata for the exact value occurrence and are not reconstructed from the current receiver's wall clock.

Journal 2 never derives payload bytes from metadata.

## Frontier coverage

For a causal context `C` and frontier `F`:

```text
covers(C,F) iff
    for every author A:
        F[A] <= C[A]
```

Missing coordinates are zero.

For a present node K with current value V and canonical certificate C:

```text
proofCoversNodeInvalidation(K,C) iff
    covers(C.event.context, S[K].nodeInvalidateFrontier)
```

Node-scoped invalidations break incoming validity proof until covered by a later certificate. Value-scoped invalidations are freshness-only assertions for one current cached value and do not independently break incoming validity proof.

## Incoming validity edge

Let `inputEdges(K) = [D0, D1, ...]` be the distinct direct semantic input edges derived from the fixed schema.

For input edge `Di -> K`, the legacy inverse validity entry must exist exactly when:

```text
edgeValid(Di,K) iff
    K is present
    and Di is present
    and S[K].certificate exists
    and S[K].certificate.value == currentValueId(K)
    and proofCoversNodeInvalidation(K,S[K].certificate)
    and S[K].certificate.basis[i] == currentValueId(Di)
```

The `"unknown"` bootstrap sentinel never equals a current `ValueId`.

The persisted legacy relation is therefore:

```text
K in valid[D]  iff  edgeValid(D,K)
```

for every structural edge D -> K.

This definition intentionally permits a stale node to retain some or all incoming validity edges.

## Freshness

Define recursively over the schema DAG:

```text
fresh(K) iff
    K is present
    and S[K].certificate exists
    and S[K].certificate.value == currentValueId(K)
    and proofCoversNodeInvalidation(K,S[K].certificate)
    and covers(
        S[K].certificate.event.context,
        S[K].valueInvalidateFrontier
    )
    and for every direct input Di:
        Di is present
        and fresh(Di)
        and S[K].certificate.basis[i] == currentValueId(Di)
```

For a zero-input node, the final universal condition is vacuous; a current certificate which covers all applicable invalidation authority makes the node fresh.

The legacy freshness record must satisfy:

```text
freshness[K] == "up-to-date"           iff fresh(K)
freshness[K] == "potentially-outdated" iff K is present and !fresh(K)
```

## Why propagated stale events are explicit

Suppose D -> K, D is explicitly invalidated, K's value remains unchanged, and K retains its incoming validity proof with respect to D's current `ValueId`.

The runtime marks K stale even if D later revalidates unchanged. K remains stale until K itself is pulled and cache-revalidated.

Therefore a freshness-only invalidation of K cannot be represented solely by recursively inspecting whether D is currently stale. The journal authors a value-scoped invalidation for K when the legacy runtime propagates that stale transition. The certificate does not cover that later invalidation until K itself validates again.

This is what keeps the projection equal to the existing flag-based algorithm rather than making freshness automatically recover when an input becomes fresh.

## Certificate replacement

For one current `ValueId`, projection consults only the greatest represented certificate by `authorityCompare(certificate.event, ...)`.

This rule applies before compaction as well as after it. Compaction therefore loses no semantic option by deleting lower certificates.

A newer certificate may be less reusable after a later merge than an older certificate would have been. That is an intentional conservative property of Journal 2; lower historical certificates are not alternative merge candidates.

## Present cache and `oldValue`

Every supported present legacy materialization is already a legitimate cached value of its semantic node. This is the supported-state fact which discharges the `oldValue`-safety requirement `$id-8254606583674715`; Journal 2 does not weaken the ordinary computor contract in order to retain caches.

The ordinary IncrementalGraph algorithm may keep that cached value while dependencies change arbitrarily. When the node is later pulled and its incoming cache proofs do not all hold, the computor receives the current input values together with the currently stored cache as `oldValue`.

Therefore Journal 2 synchronization does not need an additional provenance or serial-history proof merely because the final input `ValueId`s differ from the cache certificate basis or originated on other replicas. Such differences are represented by missing incoming validity edges and stale freshness. They do not make the cached payload itself illegal to retain.

The computor's existing `Unchanged` rule remains authoritative: after invocation with the final inputs and retained `oldValue`, it may preserve the cached value only when doing so is semantically admissible for those current inputs.

The `"unknown"` bootstrap/reset basis sentinel likewise means only that historical validity provenance is unavailable. It does not mean that the materialized cache cannot be supplied as `oldValue`.

A present cache is removed by synchronization only when some independent structural rule makes materialization impossible, principally dependency closure when a required direct input is finally absent.

## Dependency closure

A supported materialized graph is dependency-closed:

```text
K present => every D in inputEdges(K) is present
```

If a synchronization candidate would violate this rule, synchronization must normalize the candidate by creating destructive authority for K before publication.

## Physical identifiers

Journal semantics are keyed by semantic `NodeKey`, not by `NodeIdentifier`.

The physical `NodeIdentifier` used in a final legacy replica may be retained locally, copied from a selected source when collision-free, or newly allocated according to the existing identifier rules. This physical choice must not change Journal 2 semantic selection.

The final `identifiers_keys_map`, `values`, `freshness`, `timestamps`, and `valid` records must continue to satisfy all existing storage invariants.

## Timestamp records and value authority

A normal synchronization which adopts a foreign `ValueId` copies the complete selected value record, including the source timestamps associated with that value occurrence. It does not combine value bytes from one occurrence with timestamps from another and does not use synchronization execution time as a replacement value timestamp.

The origin value event's HLC physical seed was the occurrence's `modifiedAt`, but its persisted `authorityTime` may be later because HLC monotonicity must extend happened-before. Projection does not recompute or normalize that authority from the timestamp after the event has been authored.

Replicas which already represent the same `ValueId` are required by the supported-state invariant to carry the same semantic value/timestamp record and the same immutable `ValueRef.context`/`authorityTime` for that occurrence.

## Consistency validation

Opening, staging, migration, synchronization, restoration, reset, and compaction may validate that:

- every present journal summary has a legacy materialization;
- every absent journal summary is absent from legacy materialized storage;
- every fresh legacy node equals the journal-derived freshness;
- every legacy validity edge equals `edgeValid`;
- every materialized dependency is materialized;
- current certificates name the current value and have the exact schema-derived basis arity;
- all copies of one `JournalEventId` agree on immutable context/authority time;
- journal references are well-formed and bounded by represented causal/authority knowledge;
- every node-summary invalidation frontier coordinate is bounded by the corresponding header `causalSummary` coordinate as required by J2-INV-8;
- every retained head/certificate EventRef is bounded by the local header causal/authority high-water marks as required by J2-INV-9; and
- locally witnessed header/event facts are consistent with J2-INV-7: whenever a retained event is covered by `causalSummary`, its authority time is not greater than `authorityClock`.

J2-INV-7 also covers events whose raw EventRefs were removed by compaction. Supported readers may rely on that transition-maintained invariant; consistency validation is not required to reconstruct compacted-away history solely to prove the header pairing again.

Unsupported inconsistencies are errors. Synchronization must not repair them by payload equality or by inventing provenance.
