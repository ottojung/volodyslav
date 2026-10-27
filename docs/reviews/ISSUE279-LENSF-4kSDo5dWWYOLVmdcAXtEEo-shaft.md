# Independent Review — Lens F: routine-open history independence + publication-window atomicity (issue #279)

**Reviewer:** agent-4kSDo5dWWYOLVmdcAXtEEo-shaft (Lens F — independent, read-only review; authored none of the implementation)
**Repository:** https://github.com/ottojung/volodyslav.git (verified via `git ls-remote`)
**Reviewed SHA:** `52147e8f1f7ea46ef6e8196a5c9e05d7be91313d` (`origin/next-waterfall-7f3c`; rechecked via `git ls-remote` before and after — unchanged; master `282fc235` untouched)
**Isolated clone:** `/tmp/opencode/agent-4kSDo5dWWYOLVmdcAXtEEo-shaft-279-lensF` (branch `review/279-lensF-4kSDo5dWWYOLVmdcAXtEEo-shaft` created only to hold this report; no source/spec edits)
**Approach:** static trace of the routine-open path and all publication-batch assembly sites against the normative storage/lifecycle/testing owners, plus execution of the five directly covering suites. No CI result treated as proof; no reviewer coordination (Lens A/B/C/D/E reports read only to avoid repeating their lenses, after this lens was fixed).
**Coverage:** routine-open O(1+G) history independence; publication-window atomicity (ordinary, sync, reset, recovery, bootstrap-install, migration M1/M2-M3); writer-head rollback guard; retained-summary co-persistence. NOT covered: full sync authority semantics (Lens C), full persistence fuzzing (Lens B), spec-diff disposition (Lens D), checklist conformance (Lens E).

## Verdict: REQUEST_CHANGES (confidence: high on F-N1 carry-forward; medium-high on positives below)

The Lens F scope itself passes: routine open performs no history-proportional I/O and every *active-pair* publication lands records + occurrence updates + committed state (+ retained summary where applicable) in one batch. The blocker is a carried-forward defect in scope-adjacent code this lens depends on: the joining-bootstrap HLC successor still uses `Number()` at this exact head (Lens B N1, re-verified below), which contradicts the arbitrary-precision authority contract the publication window relies on. A second minor is test fragility (5 s timeouts flake under load).

## Normative basis

- `docs/specs/incremental-graph-journal-testing.md` §Routine-open history-independence tests + bound `$id-7429043816351276`: routine-open work is O(1+G), independent of H.
- `docs/specs/incremental-graph-journal-storage.md` §Startup validation: routine open bounded by current state, not retained history; §Change-bounded proof summary; §Derived indexes (maintained index updated in durable staging before the state it describes becomes active).
- `docs/specs/incremental-graph-journal-types.md` §AuthorityTime: `logical` is a non-negative arbitrary-precision integer.
- `docs/specs/incremental-graph-journal-well-formedness.md` §Authority consistency: every happened-before predecessor compares strictly less.

## Finding F-N1 (MAJOR, carry-forward, merge blocker): joining-bootstrap HLC successor still lossy at this head

- **Code:** `backend/src/generators/incremental_graph/journal/bootstrap/joining_support.js:69-79` (`compareAuthorityAscending` converts decimal logical strings via `Number()`); `:173-184` computes the next logical as `String(Number(...) + 1)`.
- **Re-verification at exact head:** source inspection confirms the `Number()` conversions are still present at `52147e8f` (see `sed -n '60,90p;165,190p'` output in validation). This is the Lens B N1 defect, unresolved: logical values above 2^53 compare equal and allocate non-increasing successors, contradicting the arbitrary-precision §AuthorityTime contract and §Authority consistency.
- **Why it blocks Lens F:** the publication window's freshness/authority ordering assumes strictly increasing successor authority for joining records; a tied/regressed logical breaks the invariant the atomic batch is supposed to durably establish.
- **Fix direction (for implementers, not applied here):** use `compareAuthorityTime`/`compareJournalSequence` and `requireSuccessorJournalSequence` in the joining cursor (as the canonical candidate path already does), plus a >2^53 regression test.

## Positives (checked, no new finding)

1. **Routine open performs no history-proportional I/O.** `journal_routine_open_history_independence.test.js:86-100` instruments the journal sublevel so `get("record|…")` and `keys()` iteration throw; open must succeed on committed state (`state`) + per-node occurrence keys only. Result: 3/3 pass. `prepare_graph_storage.js:82-87` documents the bound; `retained_state.js:7` forbids reset/sync/routine-open from falling back to scanning history.
2. **Ordinary/sync/reset/recovery/bootstrap publications are single-batch.** `journal_store/journal_database.js:286-325` (`appendJournalPublicationOps`) appends record puts + occurrence updates + `JOURNAL_STATE_KEY` put (+ retained-state op when supplied) into the caller's single `operations` array. Callers: `graph_state.js:557`, `journal_publish/sync_publication.js:129`, `journal_publish/reset_publication.js:136`, `journal_recovery_source.js:469`, `journal_bootstrap_install.js:230` — all same-batch. `journal_database.js:247-257` (`readCommittedWriterState`) is one O(1) `get("state")`; `writer_head.js:39-50` (`reconcileRetainedWriterHead`) is one `retainedLengthOf` call, fails closed on writer-behind.
3. **Bounded validation probes hold.** `journal_context_closure_linear.test.js` + `journal_publication_bounded_validation.test.js` pass (part of the 24/24 below), consistent with the PR #1705 linearity fix.

## Watch item F-W1 (MINOR, not a blocker): migration M1 batch omits the retained summary

- `migration_journal.js:160-164` (`publishMigrationM1`) calls `appendJournalPublicationOps` **without** `retainedState`, then `batch(operations)`; the retained replay summary for the migration target is appended later (`:257-265`, `repairMigrationJournal` + `appendRetainedStateOp`) in a second batch.
- **Why not a blocker:** both batches land on the *inactive* target before cutover (`buildMigrationJournal` doc `:168-176`: "a failure anywhere in between leaves the previous active pair selected"), so no crash exposes a half-published active pair. Noted for implementers: if the staging ever becomes observable, the two batches must merge.

## Minor F-W2: history-independence suite flakes under load (test fragility)

- First combined run: 2 failed / 24 with `Exceeded timeout of 5000 ms` at `journal_routine_open_history_independence.test.js:219` (heavy H=320 linear probe sharing the event loop). Immediate rerun, alone and combined: 3/3 and 24/24 pass with no code change. Suggest raising that test's timeout or splitting the heavy probe from the timing-sensitive open tests.

## Validation commands / results (exact head `52147e8f`)

- `git ls-remote … refs/heads/next-waterfall-7f3c` before and after: `52147e8f…` both times; `git rev-parse HEAD` in clone: `52147e8f…`.
- `npx jest --runInBand --runTestsByPath backend/tests/journal_routine_open_history_independence.test.js backend/tests/journal_publication_window.test.js backend/tests/journal_atomicity_requirement.test.js backend/tests/journal_context_closure_linear.test.js backend/tests/journal_publication_bounded_validation.test.js` → **5 suites, 24 tests passed** (final run; one earlier combined run showed 2 timeout-flakes, rerun clean as documented above).
- `sed -n '60,90p;165,190p' …/journal/bootstrap/joining_support.js` → `Number(journalSequenceToString(…))` conversions present (F-N1).
- No source/spec edits; `git status --short` clean except this report file.

## Limitations

Did not run the whole backend suite, OS-level power-loss injection, or true multi-process write races. Did not re-litigate Lens A/C/D/E findings. Report is scoped to Lens F; it is not a waterfall-to-master sign-off — four-lens disposition, spec-diff disposition, release-doc fix, and green CI at final head are still required per the issue.

**Verdict: REQUEST_CHANGES** (F-N1 must be fixed and re-reviewed at the new head; F-W1/F-W2 are non-blocking). @ottojung
