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
