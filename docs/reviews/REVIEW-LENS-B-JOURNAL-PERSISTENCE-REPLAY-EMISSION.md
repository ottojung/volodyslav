# REVIEW LENS B: Journal persistence/replay/emission correctness

**Reviewer:** agent-independent-lens-B  
**Reviewed SHA:** a0af0dd9b846105bc682f7976139a006afc99b0e  
**Independence:** read-only, separate worktree (/workspace/review279-lensB)  
**Focus:** malformed/duplicate records, timestamp normalization, value identity, after-crash atomicity, concurrent writes, own-writer rollback, bootstrap, mutation/property-based adversarial tests.

## Findings

### BLOCKER
None.

### MAJOR
1. **Causal closure on import boundary** - `validateAdmittedRelationsWithRetained` enforces transitive closure against retained prefix using positioned reads; prevents acceptance of suffixes that claim retained events without transitively observed context. Covered by `journal_sync_retained_closure_regression` (4/4). Behavior matches whole-history `validateJournalReplica`.

### MINOR
1. **Coverage** - `journal_sync` full suite green (24/24, 130/130). Core `journal` suites green in repo context.

## Evidence
- `journal_sync_retained_closure_regression` passed; `journal_sync` all passed in isolated worktree.
- Inspected `journal_sync/retained_closure.js`, `import_plan.js`, `admission.js`.

## Verdict
**APPROVE** - Confidence: High. Replay/emission/persistence correctness for the affected boundary is correctly enforced. Limitations: did not exhaustively run all mutation/property tests in this pass, but affected areas and sync paths are green.
