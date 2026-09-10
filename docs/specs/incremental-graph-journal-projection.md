# IncrementalGraph Journal 2 Projection

## Purpose

This specification defines how Journal 2 metadata and the unchanged legacy payload sublevels determine the observable IncrementalGraph materialization.

Journal 2 does not replace `values`, `freshness`, `timestamps`, `valid`, or `identifiers_keys_map`. Instead, supported persisted state must satisfy the projection invariants below.

## Semantic address and current value

For a `NodeKey K`, let `S[K]` be its `NodeJournalSummary`.

If `S[K].head.kind == "absent"`, K must be unmaterialized in the legacy graph and `S[K].createdAt` must be absent.

If `S[K].head.kind == "present"`, K must be materialized, its legacy payload and `modifiedAt` must be those associated with `S[K].head.value.id` under the supported lifecycle, and the legacy `createdAt` record must encode the same instant as the `CreationTime` retained in `S[K]`:

```text
canonical(legacyCreatedAt(K)) == S[K].createdAt
```

Here and below `canonical(timestamp)` means the exact epoch-millisecond instant defined for `CreationTime` in `incremental-graph-journal-types.md`; it compares timestamp meaning, not textual ISO spelling.

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

If two represented certificates expose the same `certificate.event.id`, they are claims about the same immutable `ValidateEvent` and therefore MUST agree on the event context/authority time, target `value`, and exact `basis`. A detectable disagreement is unsupported state; it is not resolved by choosing either copy.

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

For Journal 2, `modifiedAt` belongs to the selected value occurrence. `createdAt` is node/materialization-lineage metadata retained as a `CreationTime` in `NodeJournalSummary` and carried by the current present head. Ordinary local value replacement may carry that lineage timestamp forward even though it creates a new head; deletion clears it, and rematerialization from absence starts a new lineage timestamp.

Synchronization joins the pair `(head, createdAt)` with the following rule. First compare heads by ordinary semantic-head authority. A strictly greater head wins together with its own creation-time metadata. If the heads are the same present head, retain the earlier `CreationTime`. If the same selected head is absent, retain no creation time:

```text
joinCreation((H1,C1), (H2,C2)) =
    (H1,C1)              if H1 > H2
    (H2,C2)              if H2 > H1
    (H1,min(C1,C2))      if H1 == H2 and H1 is present
    (H1,none)            if H1 == H2 and H1 is absent
```

Equality of heads here is semantic head equality under the immutable-event-identity rule, not payload equality. This is a lexicographic join: the totally ordered head is the primary coordinate and reverse-time minimum is used only inside an equal present head. It is therefore deterministic, idempotent, commutative, and associative. In particular, a losing head's earlier creation time cannot leak through a tombstone or later winning materialization merely because synchronizations are grouped in a different order.

Equivalently, for a final present K with selected head H:

```text
S[K].createdAt = min(
    createdAt from each input summary whose head == H
)
```

An input whose head loses selection contributes no creation time, and neither does an input where K is absent. Every supported present input summary carries a `createdAt`, so the selected present head always has at least one contributing creation time.

For a fixed selected head, the retained creation instant may only move earlier as more copies of that head are represented. If a greater head later replaces it, the old head's creation metadata is discarded and the newly selected head's carried lineage timestamp may be numerically later. An absent/tombstone head carries no creation time, so a later rematerialization does not inherit `createdAt` from the deleted materialization.

The legacy timestamp record for every final present K MUST encode exactly `S[K].createdAt`:

```text
canonical(legacyCreatedAt(K)) == S[K].createdAt
```

When synchronization must rewrite the legacy timestamp record, it serializes a valid legacy `createdAt` representing that exact instant; the textual timezone spelling of an equivalent ISO representation has no Journal meaning. It MUST NOT substitute synchronization execution time.

The selected head's own contributing representation satisfies `canonical(createdAt) <= canonical(modifiedAt)`. Taking a minimum over copies of that same head cannot increase the creation instant, so the resulting legacy timestamp record continues to satisfy `createdAt <= modifiedAt` by instant comparison.

A normal synchronization which adopts a foreign `ValueId` copies the selected occurrence's payload and `modifiedAt`; the final `createdAt` comes from the merged summary rule above rather than from value-occurrence identity. A `createdAt` change is therefore synchronization-relevant `NodeJournalSemanticPart` state and is transferred by both full and incremental synchronization.

The origin value event's HLC physical seed was the occurrence's `modifiedAt`, but its persisted `authorityTime` may be later because HLC monotonicity must extend happened-before. Projection does not recompute or normalize that authority from the timestamp after the event has been authored.

Replicas which already represent the same `ValueId` are required by the supported-state invariant to carry the same semantic payload and `modifiedAt` and the same immutable `ValueRef.context`/`authorityTime` for that occurrence. Their carried materialization-lineage `createdAt` values may differ until synchronization joins equal selected heads by minimum. Identity-preserving Journal-2-aware migration must preserve the payload/`modifiedAt` invariant through its replica-stability requirement.

## Consistency validation

Opening, staging, restoration, and compaction MAY validate the following. Migration, synchronization, and reset MUST validate all of it before cutting over to a constructed target state; failure aborts the transition and leaves the active replica pointer unchanged:

- every present journal summary has a legacy materialization and a retained `createdAt`;
- every absent journal summary is absent from legacy materialized storage and has no retained `createdAt`;
- every present node summary's retained `createdAt` equals `canonical(legacyCreatedAt(K))`;
- every fresh legacy node equals the journal-derived freshness;
- every legacy validity edge equals `edgeValid`;
- every materialized dependency is materialized;
- current certificates name the current value and have the exact schema-derived basis arity;
- all retained/raw structures available to the transition which claim the same `JournalEventId` agree on the immutable semantic event identity defined in `incremental-graph-journal-types.md`, including context/authority time, node, event kind, and all exposed kind-specific semantic body fields; in particular equal certificate event IDs require equal `value` and `basis`;
- every repeated `ValueId` identifies the same semantic NodeKey, exact payload, and `modifiedAt`; `createdAt` is deliberately excluded from value-occurrence identity;
- every present legacy timestamp record is parseable and satisfies `canonical(createdAt) <= canonical(modifiedAt)`;
- journal references are well-formed and bounded by represented causal/authority knowledge;
- every node-summary invalidation frontier coordinate is bounded by the corresponding header `causalSummary` coordinate as required by J2-INV-8;
- every retained head/certificate EventRef is bounded by the local header causal/authority high-water marks as required by J2-INV-9;
- `header.causalSummary[header.writer] == header.localJournalCounter` as required by J2-INV-10;
- locally witnessed header/event facts are consistent with J2-INV-7: whenever a retained event is covered by `causalSummary`, its authority time is not greater than `authorityClock`;
- no physical `NodeIdentifier` absent from the final `identifiers_keys_map` appears as a key in `values`, `freshness`, `timestamps`, or `valid`, or as a dependent identifier stored inside `valid`;
- the final `identifiers_keys_map` is bijective between exactly the semantic keys whose journal head is present and their surviving physical `NodeIdentifier`s; and
- every present semantic key's legacy value, freshness, and timestamp records are reachable under exactly one physical `NodeIdentifier`, with no losing/orphaned identifier retaining legacy records.

The final three checks are deliberately physical-identifier checks. Journal projection is keyed by `NodeKey` and therefore cannot by itself detect an orphaned losing `NodeIdentifier` whose surviving semantic key is otherwise represented correctly.

J2-INV-7 also covers events whose raw EventRefs were removed by compaction. Supported readers may rely on that transition-maintained invariant; consistency validation is not required to reconstruct compacted-away history solely to prove the header pairing again. The same principle applies to immutable event bodies removed by compaction: validation rejects conflicts among retained/raw claims it can observe, but does not recreate discarded historical bodies solely to compare them.

Unsupported inconsistencies are errors. Synchronization must not repair them by payload equality, by inventing provenance, or by raising a writer-local allocator counter from foreign/same-writer observation.