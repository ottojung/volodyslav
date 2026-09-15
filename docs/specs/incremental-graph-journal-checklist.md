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

- a configured transport-neutral **cohort bootstrap source** returns exactly exists / definitely absent / indeterminate-or-error;
- exists -> returns immutable `CanonicalBootstrapSnapshot`, not an arbitrary current Journal snapshot;
- definitely absent -> create canonical bootstrap;
- indeterminate/error -> migration fails and MUST NOT create competing canonical history;
- the source's definite-absence semantics arbitrate first creation; competing canonical artifacts are unsupported;
- creator bootstrap represents its accepted legacy payloads/timestamps/identifiers/freshness/validity exactly;
- creator freezes `bootstrapFrontier` immediately after bootstrap and before ordinary Journal authoring;
- artifact exposes exactly records through that frontier and retains exact bootstrap-target version/schema;
- artifact remains available/immutable after ordinary cohort history or later migrations;
- joining artifact version/schema must exactly equal the configured bootstrap target or fail with `JournalVersionCompatibilityError` before authoring history;
- joining installation retains canonical records verbatim and preserves its own local writer fingerprint/watermark;
- bootstrap join is not reset and does not force projection equality with the local legacy cache;
- exact equal legacy occurrences keep canonical ValueIds;
- locally different/local-only occurrences get historical joining-writer bootstrap ValueEvents;
- divergent legacy values do not observe canonical conflicting values solely because bootstrap code read the artifact;
- joining bootstrap ValueEvent authority is seeded from that occurrence's own legacy `modifiedAt`;
- normal Journal authority resolves conflicting legacy occurrences;
- canonical-present/local-absent does not create a bootstrap DeleteEvent;
- proof/freshness baseline records are authored after values using normal closed contexts;
- stale partial validity uses controlled `"unknown"`;
- cutover is atomic at the bootstrap target version;
- ordinary supported Journal-aware migrations then advance to running version before ordinary compatible synchronization imports post-bootstrap history.

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
- replayed result equals target semantic graph;
- this causally-later target-repair algorithm is never reused as bootstrap legacy-conflict resolution.

## 12. Journal-aware migration

Acceptance:

- complete retained old history is deterministically rewritten into target format preserving IDs/meaning;
- target has one format only;
- every affected retained ValueEvent uses one pure per-record payload codec independent of selected/non-selected status and replica-local state;
- replicas retaining the same historical record produce the same target-format body;
- `keep` preserves selected ValueId;
- `override()` preserves selected ValueId and semantic value even when target-version payload representation changes;
- `override()` result is checked against the canonical codec output for the selected record and mismatch fails before cutover;
- a record is rewritten identically even on a replica where it is historical rather than selected;
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

- one current format per active replica;
- frozen bootstrap artifact may separately remain at its original bootstrap target format;
- known graph/journal mismatch not exposed;
- valid history can rebuild damaged projection;
- invalid authoritative history rejected;
- context closure, allocator, high-water, and indexes reconstructible/validated.

## 14. Error model

Provide actionable categories for writer fork, stream gap, transitive causal-context closure failure, ValueId reference causality failure, current-format record validation, ordinary snapshot/bootstrap-artifact version/schema incompatibility, projection invariant failure, migration-decision mismatch, and publication/source-read failure.

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
- frozen canonical bootstrap source decision and original-cut preservation;
- late bootstrap cannot replay stale local values as causally newer writes;
- concurrent legacy conflict uses legacy `modifiedAt` authority;
- legacy absence does not fabricate deletion;
- bootstrap-target join followed by ordinary migration chain;
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

and all causal, identity-preservation, compatibility, and regression laws above are covered by implementation tests/models.
