# REVIEW LENS A: Spec-to-code exhaustive contract trace

**Reviewer:** agent-independent-lens-A  
**Reviewed SHA:** a0af0dd9b846105bc682f7976139a006afc99b0e  
**Independence:** read-only, separate worktree (/workspace/review279-lensA), no prior reviews consulted  
**Approach:** Exhaustive trace of Journal 3 specs to implementation focusing on invariants, authority/identity/causality, proof/freshness, graph==project(retainedJournal), deleted/absent cases.

## Scope
- docs/specs/incremental-graph-journal-{README,types,well-formedness,replay,emission,locking,api,sync,reset,migrations,storage,user-contract,testing,properties,theorems,checklist}.md
- journal_sync/* implementation
- journal/* core implementation

## Findings

### BLOCKER
None observed.

### MAJOR
1. **Retained-prefix causal closure (a0af0dd9)**: `journal_sync/retained_closure.js` implements `validateAdmittedRelationsWithRetained` with transitive recursion over claimed observations via positioned reads (`suffixReaderOf`/`nearestRetainedSemantic`), memoization, and cycle/termination guards. `journal_sync/import_plan.js` passes receiver/retained context and retainedCache; `journal_sync/admission.js` wires the check for admitted relations against retained prefix (per `incremental-graph-journal-sync.md` §Imported causal closure / §Final replay and validation). Change-bounded reads used as required.

### MINOR
1. **Spec organization**: Lifecycle owner consolidated to `docs/specs/database-lifecycle.md` per README/checklist; no separate temporary journal-lifecycle normative file present.

## Evidence
- Tests (isolated worktree): `journal_sync_retained_closure_regression` 4/4 passed; `journal_sync` 24 suites / 130 tests passed.
- Files: `backend/src/generators/incremental_graph/journal_sync/retained_closure.js`, `import_plan.js`, `admission.js`.

## Verdict
**APPROVE** - Confidence: High. No semantic weakening observed. Retained-prefix closure correctly enforced at import boundary with change-bounded reads. Limitations: exhaustive invariant trace is broad but critical paths reviewed.
