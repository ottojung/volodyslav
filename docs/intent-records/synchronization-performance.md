# Synchronization performance

$id-3572255392439745
title: Defer change-sensitive synchronization optimization until owned
date: 2026/09/10
source: @ottojung
kind: constraint

Work whose purpose is to establish or enforce an end-to-end change-sensitive time bound for regular incremental synchronization must not begin until someone is assigned to GitHub issue [#1607](https://github.com/ottojung/volodyslav/issues/1607), "Make incremental synchronization cost depend on changes, not graph size".

Issue #1607 records the desired performance direction: a valid-cursor synchronization should ultimately avoid unconditional work proportional to the total graph size when only a small number of source nodes and receiver dependents are actually affected. The exact asymptotic contract and the implementation needed to satisfy it belong to that owned work.

This constraint does not block correctness work, convergence work, or maintaining already-specified incremental indexes and cursor semantics. It specifically defers adding or enforcing the end-to-end synchronization-time guarantee.

The use of issue assignment is deliberate: assignment is the ownership signal for beginning this optimization work. When #1607 is assigned, this intent should be superseded or updated before implementation/specification work on that bound begins. Until then, unrelated Journal or synchronization work must not opportunistically take on that optimization.
