# IncrementalGraph Journal 3 Implementation Checklist

## Purpose

This checklist translates the normative Journal 3 specifications into implementation milestones and acceptance checks. It is not a second design.

## 1. Persisted journal primitives

Implement durable current-version representations for `JournalRecordId`, `JournalFrontier`, `AuthorityTime`, Value/Delete/Validate/Invalidate events, and `WriterStateRecord`.

Acceptance:

- `global/version` is the only persisted format selector for an active replica;
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
- happened-before always implies increasing authority;
- bootstrap historical-value conversion may omit canonical foreign coordinates only under its explicit lifecycle rule and the resulting actual context remains closed.

## 3. Journal snapshot

Implement `JournalSnapshot` with exact source `databaseVersion`, exact `graphSchemeString`, `localWriter`, immutable frontier, and stable range reads.

Compatibility metadata/frontier/records belong to one immutable committed source cut.

Do not reuse `JournalSnapshot` as the canonical-bootstrap artifact; §8 has the separate frozen artifact contract.

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

- configured cohort bootstrap source returns exactly exists / definitely absent / indeterminate-or-error;
- exists -> returns immutable `CanonicalBootstrapSnapshot`, not arbitrary current Journal snapshot;
- definitely absent -> create canonical bootstrap;
- indeterminate/error -> fail and MUST NOT create competing canonical history;
- definite-absence semantics arbitrate first creation; competing canonical artifacts are unsupported;
- artifact exposes exactly records through the original `bootstrapFrontier` and bootstrap target version/schema;
- artifact is immutable while this release claims support for that bootstrap target;
- artifact version/schema must exactly equal the running release's expected bootstrap target or fail with `JournalVersionCompatibilityError` before authoring;
- future releases are not required to keep unsupported historical bootstrap targets, artifact codecs, or migration chains forever;
- creator publishes/finalizes artifact before ordinary post-bootstrap Journal authoring;
- if artifact creatorWriter equals local pre-Journal fingerprint, use creator-resume rather than ordinary join;
- creator-resume installs exactly artifact history, verifies artifact projection equals local legacy target, reconstructs head/watermark/high-water/projection, and authors no duplicate semantic history;
- creator-resume mismatch fails `JournalBootstrapForkError` before cutover;
- another fingerprint cannot use creator-resume;
- ordinary join preserves its own writer fingerprint/watermark;
- bootstrap join is not reset and does not force projection equality with local legacy cache;
- exact equal legacy occurrences reuse canonical ValueIds;
- local-only/different occurrences get historical joining-writer bootstrap ValueEvents;
- divergent legacy values remain concurrent with canonical conflicts unless genuine legacy causality exists;
- bootstrap value authority is seeded from the occurrence's own legacy `modifiedAt`;
- normal Journal authority resolves conflicting legacy occurrences;
- canonical-present/local-absent does not fabricate bootstrap DeleteEvent;
- two independent joiners holding the same non-canonical occurrence may assign distinct bootstrap ValueIds, with downstream staleness accepted by `$id-1635227135166767`;
- proof/freshness baseline records are authored after values using normal closed contexts;
- stale partial validity uses controlled `"unknown"`;
- cutover is atomic at bootstrap target;
- any later migration occurs only through steps this running release explicitly supports before ordinary compatible synchronization.

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
- every selected occurrence stale solely because a direct input is stale gets/retains current-value sync invalidation;
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
- when target validity removes any currently-valid incoming edge, author node-scoped reset proof barrier before target validation;
- old stronger certificates before the barrier are ineligible and cannot reintroduce removed validity;
- proof additions that need no weakening do not require a barrier solely for being newer;
- target proof uses exact target edge set with ValueIds/`"unknown"`;
- if target stores K stale and K's own selected proof is otherwise complete, ensure uncovered value-scoped reset invalidation for final K ValueId even when K is already recursively stale through input;
- later upstream `Unchanged` does not accidentally freshen such reset-stale K;
- dependents may retain own ValueId while certificates update for changed input ValueIds;
- exactly one reset delete iff current union present and target absent;
- repeated satisfied reset may no-op;
- receiver allocator remains local;
- replayed result equals target semantic graph;
- causally-later target-repair algorithm is never reused as bootstrap legacy-conflict resolution.

## 12. Journal-aware migration

Acceptance:

- complete retained old history is deterministically rewritten into target format preserving IDs/meaning;
- target has one format only;
- every affected retained ValueEvent uses one pure per-record payload codec independent of selected/non-selected status and replica-local state;
- replicas retaining same historical record produce same target-format body;
- `keep` preserves selected ValueId;
- `override()` preserves selected ValueId and semantic value even when target-version payload representation changes;
- `override()` result is checked against canonical codec output and mismatch fails before cutover;
- `invalidate` preserves cached occurrence ValueId;
- schema/proof/freshness change alone does not create ValueEvent;
- when migration target removes any currently-valid incoming edge, author node-scoped migration proof barrier before target validation;
- old stronger certificates before barrier cannot re-win by larger `basisMatchCount`;
- stale `keep`/`override` proof loss and explicit `invalidate` are covered by this barrier rule;
- target proof may be re-established with ValidateEvent targeting preserved ValueId;
- if target stores K stale and K's own proof is otherwise complete, ensure uncovered value-scoped migration invalidation even when recursive input staleness already makes replay stale;
- later upstream `Unchanged` does not accidentally freshen migration-propagated stale dependents;
- new ValueEvent only for actual create/replace semantic occurrence change;
- replicas may independently author distinct new ValueIds for genuine replacements;
- later sync of distinct replacement occurrences may stale dependents and that is accepted;
- no particular peer is required to participate in migration;
- target replay equals migration target including validity and stale-flag persistence;
- historical migration callbacks are not needed for replay;
- whole-journal rewrite may be O(history) and streamable.

## 13. Open/rebuild lifecycle

Acceptance:

- one current format per active replica;
- bootstrap artifact is lifecycle source state and is interpreted only while running software explicitly supports its target format;
- known graph/journal mismatch not exposed;
- valid history can rebuild damaged projection;
- invalid authoritative history rejected;
- context closure, allocator, high-water, and indexes reconstructible/validated.

## 14. Error model

Provide actionable categories for writer fork, `JournalBootstrapForkError`, stream gap, transitive causal-context closure failure, ValueId reference causality failure, current-format record validation, ordinary snapshot/bootstrap-artifact version/schema incompatibility, projection invariant failure, migration-decision mismatch, and publication/source-read failure.

## 15. Reference model / property verification

Priority properties:

- deterministic replay;
- context transitivity and causality -> authority;
- prefix-union algebra;
- local emission preservation;
- invalidation-aware certificate selection;
- maintenance proof barriers can weaken validity despite older stronger certificates;
- maintenance target staleness persists through later upstream `Unchanged`;
- stable snapshot compatibility;
- selected-remote stale persistence;
- repeat-sync no-op;
- normalization convergence;
- absent restore vs fresh creation;
- frozen canonical bootstrap source decision/original-cut preservation;
- creator crash after artifact publication resumes exactly without duplicate history;
- creator-resume mismatch fails bootstrap fork;
- late bootstrap cannot replay stale local values as causally newer writes;
- concurrent legacy conflict uses legacy `modifiedAt` authority;
- legacy absence does not fabricate deletion;
- independent late joiners may split identical non-canonical occurrence identity as accepted;
- unsupported historical bootstrap target fails compatibility rather than requiring permanent migration machinery;
- pure per-record format rewrite independent of replica selection;
- occurrence-preserving `override()` assertion against canonical codec;
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

and all causal, identity-preservation, compatibility, proof/freshness persistence, and regression laws above are covered by implementation tests/models.
