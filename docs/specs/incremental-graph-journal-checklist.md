# IncrementalGraph Journal 3 Implementation Checklist

## Purpose

This checklist translates the normative Journal 3 specifications into implementation milestones and acceptance checks. It is not a second design.

## 1. Persisted journal primitives

Implement durable current-version representations for `JournalRecordId`, `JournalFrontier`, `AuthorityTime`, Value/Delete/Validate/Invalidate events, and `WriterStateRecord`.

Acceptance:

- `global/version` is the only persisted format selector;
- no per-record version discriminator;
- ordered per-writer range iteration;
- canonical current-format codec;
- validation bases are explicit, duplicate-free, canonical NodeKeyString order;
- no public arbitrary journal mutation API.

## 2. Causal context validation

Acceptance:

- semantic event `(W,q)` has `context[W] == q-1`;
- every context coordinate is retained;
- if F includes semantic E, every coordinate of E.context is <= F.context;
- malformed transitive omission is rejected;
- `happenedBefore` is transitive in generated supported histories;
- happened-before always implies increasing authority.

## 3. Journal snapshot

Implement `JournalSnapshot` with exact source `databaseVersion`, exact `graphSchemeString`, `localWriter`, immutable frontier, and stable range reads.

Compatibility metadata/frontier/records belong to one immutable committed source cut.

## 4. Local publication finalization

Acceptance:

- failed transactions leave no durable sequence hole;
- successful concurrent transactions get disjoint contiguous writer ranges;
- event IDs/contexts/HLCs are allocated inside serialized finalization;
- own-writer context is exact after final ordering;
- graph+journal publish atomically;
- volatile allocator state advances only after durable success.

## 5. Ordinary graph emission

Cover fresh no-op, first materialization, changed recomputation, `Unchanged`, cache revalidation, explicit/propagated invalidation, deletion, and allocator advancement.

For every case:

```text
project(journalAfter) == graphAfter
```

## 6. Replay engine

Acceptance:

- deterministic value/delete head selection;
- transitive/reference causality enforced;
- certificate shape compatibility deterministic;
- certificate selection key exactly `basisMatchCount`, then `coversValueInvalidations`, then authority;
- no certificate mixing;
- freshness/validity reproduce graph semantics;
- full rebuild from Journal works.

## 7. Absent-installation restore

Acceptance:

- configured installation recovery source is queried first;
- source exists -> restore and adopt held snapshot `localWriter`;
- source definitely absent -> fresh fingerprint may be generated;
- source query/read failure -> startup fails and MUST NOT fall back to fresh;
- restored writer head/watermark/high-water/projection are reconstructed before new allocation.

## 8. Pre-Journal bootstrap

Acceptance:

- a configured transport-neutral **cohort bootstrap source** returns exactly exists / definitely absent / indeterminate-or-error;
- exists -> join canonical bootstrap;
- definitely absent -> create canonical bootstrap;
- indeterminate/error -> migration fails and MUST NOT create competing canonical history;
- the source's definite-absence semantics arbitrate first creation; competing canonical histories are unsupported;
- creator bootstrap represents payloads/timestamps/identifiers/freshness/validity exactly;
- joining installations retain canonical semantic records verbatim and preserve their own local writer fingerprint/watermark;
- join computes `Pc = project(canonicalJournal, localWriter=joiningFingerprint)` and applies minimal reset-style Pass 1–3 rules to target local `Glegacy` with reason `"bootstrap"`;
- unaffected equal occurrences keep canonical ValueIds;
- locally changed occurrences get only the required joining-writer ValueEvents;
- local presence/absence and validity/freshness deltas use minimal Delete/Validate/Invalidate records;
- stale partial validity uses controlled `"unknown"`;
- cutover is atomic.

## 9. Pairwise synchronization

Acceptance:

- compatibility checked from held source snapshot before interpreting records;
- every missing writer suffix imported;
- overlap verified;
- exact same-writer prefix recovery supported;
- writer fork rejected;
- import streamable;
- imported records unchanged;
- no computor execution;
- no transport acknowledgement/adoption event.

An absent installation does not enter through this receiver-required operation; it uses §7.

## 10. Synchronization normalization

Acceptance:

- structural closure authors explicit sync deletes;
- every selected occurrence stale solely because a direct input is stale gets/retains a current-value sync invalidation;
- this applies to newly selected remote ValueIds;
- basis mismatch/node invalidation/already-uncovered value invalidation do not create unnecessary markers;
- repeat sync is no-op;
- fair normalization reaches finite fixed point.

## 11. Reset

Acceptance:

- source target/compatibility from one held snapshot;
- source+receiver history retained;
- already-selected target semantic occurrence preserves ValueId;
- new ValueEvent only when semantic occurrence must actually change;
- validity/freshness-only changes use Validate/Invalidate;
- dependents may retain own ValueId while certificates update for changed input ValueIds;
- exactly one reset delete iff current union present and target absent;
- repeated satisfied reset may no-op;
- receiver allocator remains local;
- replayed result equals target semantic graph.

## 12. Journal-aware migration

Acceptance:

- complete retained old history is deterministically rewritten into target format preserving IDs/meaning;
- target has one format only;
- `keep` preserves selected ValueId;
- `override()` preserves selected ValueId and semantic value even when target-version payload representation changes;
- whole-history representation rewrite provides deterministic target-format payload conversion for retained ValueEvents affected by representation changes;
- selected override record after rewrite agrees with migration's override result;
- `invalidate` preserves cached occurrence ValueId;
- schema/proof/freshness change alone does not create ValueEvent;
- target proof may be re-established with ValidateEvent targeting preserved ValueId;
- target stale state may use value-scoped migration invalidation on preserved ValueId;
- new ValueEvent only for actual create/replace semantic occurrence change;
- replicas may independently author distinct new ValueIds for genuine replacements;
- later sync of distinct replacement occurrences may stale dependents and that is accepted;
- no particular peer is required to participate in migration;
- target replay equals migration target;
- historical migration callbacks are not needed for replay;
- whole-journal rewrite may be O(history) and streamable.

## 13. Open/rebuild lifecycle

Acceptance:

- one current format;
- known graph/journal mismatch not exposed;
- valid history can rebuild damaged projection;
- invalid authoritative history rejected;
- context closure, allocator, high-water, and indexes reconstructible/validated.

## 14. Error model

Provide actionable categories for writer fork, stream gap, transitive causal-context closure failure, ValueId reference causality failure, current-format record validation, snapshot version/schema incompatibility, projection invariant failure, and publication/source-read failure.

## 15. Reference model / property verification

Priority properties:

- deterministic replay;
- context transitivity and causality -> authority;
- prefix-union algebra;
- local emission preservation;
- invalidation-aware certificate selection;
- stable snapshot compatibility;
- selected-remote stale persistence;
- repeat-sync no-op;
- normalization convergence;
- absent restore vs fresh creation;
- canonical bootstrap source decision and join-with-delta;
- occurrence-preserving `override()` and migration;
- accepted independent-replacement migration staleness;
- minimal deterministic reset;
- deterministic whole-journal representation migration.

## 16. Performance boundary

Issue #1607 owns end-to-end change-sensitive synchronization complexity.

Correctness must not be weakened to satisfy an unstated performance target. Whole-journal representation migration cost is separately accepted.

## 17. Completion condition

Journal 3 implementation is complete only when ordinary operations, startup/restore, bootstrap/migration, synchronization, reset, restart/open, and rebuild preserve:

```text
persistedGraph == project(retainedJournal)
```

and all causal, identity-preservation, compatibility, and regression laws above are covered by implementation tests/models.