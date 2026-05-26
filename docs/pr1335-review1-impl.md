# PR #1335 Review 1: Detailed Implementation Plan

## Planned code changes

1. **Lock module updates**
   - Add explicit per-node pull mutex helper.
   - Keep mode lock APIs unchanged.
   - Document acquisition ordering clearly.

2. **Pull path updates**
   - Acquire pull mode lock globally for phase exclusion.
   - Acquire per-node pull mutex for concrete target node during top-level pull execution.
   - Preserve nested pull behavior via explicit transaction argument passing.

3. **Transaction lock scope updates**
   - Reduce computed-state mutex usage so it does not serialize entire pull transactions.
   - Keep identifier lookup commit ordering and consistency guarantees.

4. **Tests**
   - Update/add concurrency assertions to enforce:
     - same-node pull serialization,
     - different-node pull parallel start,
     - observe vs pull incompatibility,
     - invalidate/read compatibility.

5. **Documentation alignment**
   - Ensure comments in lock and transaction code describe true behavior.

## Validation plan

1. Run focused tests:
   - incremental graph concurrency tests,
   - identifier map correctness tests,
   - migration fixture tests.
2. Run full test suite.
3. Run static analysis.
4. Run build.

## Done criteria

- All checks pass.
- Different-node pulls are no longer globally serialized by transaction mutexing.
- Identifier persistence remains consistent and race-safe.
