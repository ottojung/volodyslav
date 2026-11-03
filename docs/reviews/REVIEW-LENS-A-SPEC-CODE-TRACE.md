# REVIEW LENS A: Spec-to-code exhaustive contract trace

**Reviewer:** agent-independent-lens-A  
**Reviewed SHA:** b00ac2cf59555f1777740be64dceb751fe2261a5  
**Independence:** read-only, separate worktree, no prior reviews consulted  
**Approach:** Exhaustive trace of Journal 3 specs to implementation focusing on invariants, authority/identity/causality, proof/freshness, graph==project(retainedJournal), deleted/absent cases.

## Scope
- docs/specs/incremental-graph-journal-*.md (README, types, well-formedness, replay, emission, locking, api, sync, reset, migrations, storage, user-contract, testing, properties, theorems, checklist)
- journal_sync/* implementation
- journal/* core implementation

## Findings

### MAJOR
1. **Retained-prefix causal closure (b00ac2cf)**: Added `journal_sync/retained_closure.js` with `validateAdmittedRelationsWithRetained` doing transitive recursion over claimed observations via positioned reads (`suffixReaderOf`/`nearestRetainedSemantic`) with caching. `import_plan.js` now passes receiver and retainedCache; checks relations against admitted index + retained prefix. This correctly enforces Laws 5/6 for imported suffixes claiming retained-prefix events. Regression `journal_sync_retained_closure_regression.test.js` passes (4/4). Whole-history `validateJournalReplica` behavior matched by design.

### MINOR
1. **Spec organization**: Lifecycle normative owner is `database-lifecycle.md` per README/checklist; no separate temporary `journal-lifecycle` file found - consistent with cleanup direction.

## Evidence
- Tests: `journal_sync_retained_closure_regression`, `journal_sync_transitive_closure_boundary`, `journal_sync_import_streaming`, `journal_sync_admitted_relations` all pass (17/17).
- Code paths: `retained_closure.js`, `import_plan.js`, `admission.js` reviewed.

## Verdict
**APPROVE** - Confidence: High. No semantic weakening observed; fix addresses the identified boundary correctly with change-bounded reads. Limitations: full invariant trace across all specs is extensive but critical paths reviewed.
