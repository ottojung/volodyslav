# Journal bootstrap

$id-1635227135166767
title: Independent late bootstrap may split non-canonical occurrence identity
date: 2026/09/16
source: @ottojung
kind: accepted-tradeoff

The canonical pre-Journal bootstrap guarantees shared `ValueId` identity for legacy occurrences which are observationally the same occurrence as the canonical bootstrap cut.

Two independent late bootstrap joiners may nevertheless hold the same legacy occurrence which differs from the canonical cut. Because that non-canonical occurrence had no Journal identity before either join, each joiner may author its own `ValueEvent(reason="bootstrap")` and therefore assign a distinct `ValueId` to what had been the same legacy materialization.

When those histories later synchronize, normal Journal conflict authority selects one occurrence. A dependent certificate naming the losing bootstrap `ValueId` may stop matching and the dependent may become stale and require revalidation or recomputation.

This identity split is accepted rather than introducing an additional pre-Journal occurrence-reconciliation protocol, synthetic shared writer, payload-derived identity, or mandatory coordination between late joiners. The canonical bootstrap still prevents this split for every occurrence equal to the canonical cut, which is the common basis it is responsible for establishing.

---

$id-4465456703882268
title: Late bootstrap negative evidence may conservatively outlive unseen revalidation
date: 2026/09/16
source: @ottojung
kind: accepted-tradeoff

A late pre-Journal join is built from the frozen canonical bootstrap cut plus the joining installation's persisted legacy state. The legacy state does not contain a causal coordinate that can order its stale/proof-negative evidence relative to ordinary Journal validations authored after the frozen bootstrap cut but before that installation upgrades.

Consequently, when those post-bootstrap records are later synchronized, a validation which did not causally observe the late join's negative evidence does not erase it merely because its wall-clock execution happened later. The affected occurrence may remain stale or lose an incoming proof edge until a validation causally after the late join evidence revalidates it.

This conservative revalidation/recomputation cost is accepted rather than inventing causal order which the pre-Journal state did not record. It preserves soundness: bootstrap must not discard a real legacy invalidation merely because another host happened to revalidate the same occurrence while the late installation was offline.
