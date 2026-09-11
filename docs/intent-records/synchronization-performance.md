# Synchronization performance

$id-3572255392439745
title: Defer incremental synchronization time bound to issue 1607
date: 2026/09/10
source: @ottojung
kind: accepted-tradeoff

Journal 2 currently imposes no end-to-end asymptotic running-time requirement on valid-cursor incremental synchronization. In particular, the current specification does not require `O(N)`, `o(N)`, affected-closure-proportional, change-sensitive, or any other running-time bound.

GitHub issue [#1607](https://github.com/ottojung/volodyslav/issues/1607), "Make incremental synchronization cost depend on changes, not graph size", owns the future incremental-synchronization performance contract. That issue explicitly includes receiver validation, inactive-target construction/cutover, identifier/index maintenance, source processing, and other lifecycle work which could introduce graph-sized work. Until #1607 is resolved and this intent is superseded or updated, correctness-oriented Journal 2 specifications may require or permit whole-replica work even on a valid-cursor incremental synchronization.

The change-index iterator and reverse structural-edge index remain required synchronization structures because they define source-change discovery and affected-dependent semantics, but their existence does not currently imply an end-to-end time guarantee or prohibit additional scans of unrelated graph state for validation, target construction, lifecycle, or other correctness work.

This deferral concerns running time only. Existing space and streaming requirements remain normative, including bounded individual journal values, compacted-journal size bounds, and the requirement that `possibleMaybeChanges` itself not materialize the complete changed-node range in RAM.
