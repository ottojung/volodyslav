# Synchronization performance

$id-3572255392439745
title: Defer incremental synchronization time bound to issue 1607
date: 2026/09/13
source: @ottojung
kind: accepted-tradeoff

Journal 3 currently imposes no end-to-end asymptotic running-time requirement on synchronization when a receiver already has part of the relevant journal history. In particular, the current specification work does not need to prove `O(N)`, `o(N)`, affected-closure-proportional, change-sensitive, or another end-to-end running-time bound before the replay-log synchronization semantics are considered correct.

GitHub issue [#1607](https://github.com/ottojung/volodyslav/issues/1607), "Make incremental synchronization cost depend on changes, not graph size", owns the future change-sensitive **non-validation** synchronization performance contract: materialized-view construction/cutover, identifier/index maintenance, graph traversal, normalization work, and other lifecycle processing which may still be graph-sized even when only a small Journal suffix is new.

Historical validation is **not** deferred by this intent. Its complexity contract is owned by `$id-6845129073418625`: synchronization/reset historical validation is O(C) in newly admitted/affected state and must not rescan unrelated retained history.

Until #1607 is resolved and this intent is superseded or updated, correctness-oriented Journal 3 specifications may permit whole-replica **non-validation** work even when only a small journal suffix is new.

This deferral concerns non-validation running time only. It does not weaken the historical-validation bounds in `$id-6845129073418625`, synchronization correctness, convergence, replay correctness, or independently stated streaming requirements.

---

$id-4924739474925738
title: Streamable journal synchronization
date: 2026/09/13
source: @ottojung
kind: requirement

Journal synchronization and replay processing must be streamable over journal records without requiring the complete journal history, complete newly transferred suffix, or complete changed-node set to be materialized in RAM as one collection.

Implementations may retain bounded iterator/runtime buffers and whatever local derived state is independently required by IncrementalGraph processing, but the journal transport/replay layer itself must support incremental consumption of records.

This requirement does not imply the deferred end-to-end running-time bound from `$id-3572255392439745`. Whole-replica **non-validation** graph work may still be permitted for correctness; historical validation remains separately bounded by `$id-6845129073418625`.
