# Detailed implementation plan for Review #1 follow-up

## Phase 1 — Documentation and boundary tightening (this change set)
1. Add reviewer-facing docs (this folder) to explain:
   - high-level architecture shift,
   - concrete risk points,
   - principled forward strategy.
2. Remove ambiguous internal wording where practical in touched code.
3. Add/adjust small targeted tests if boundary behavior is modified.

## Phase 2 — API boundary hardening
1. Audit function signatures in incremental graph modules:
   - mark each parameter as semantic key or persisted identifier.
2. Replace mixed “stringly” boundary calls with explicit conversion helpers.
3. Remove permissive conversion patterns where they mask domain confusion.

Acceptance criteria:
- No public/internal API claims to accept `NodeIdentifier` unless it truly supports persisted IDs.
- Failures for missing identifier mappings are explicit (not JSON parse side-effects).

## Phase 3 — Lookup mutation authority
1. Confirm every mutation path (pull/sync/migration) routes through shared invariant helpers.
2. Prevent direct whole-map replacement in concurrent paths unless merge policy is applied.
3. Verify transaction rollback cannot leak in-memory uncommitted mappings.

Acceptance criteria:
- Concurrency tests prove no mapping loss under parallel pulls.
- Failed transaction leaves in-memory lookup identical to persisted snapshot.

## Phase 4 — Replica cutover + sync/migration durability checks
1. Validate ordering: writes flush before replica pointer switch.
2. Validate migration-created nodes always produce persisted mappings.
3. Validate sync collision reconciliation converges deterministically.

Acceptance criteria:
- Crash/restart simulation preserves active replica consistency.
- Merged/migrated nodes remain reachable by semantic resolution.

## Phase 5 — Final verification
Run full repository checks:
- `npm test`
- `npm run static-analysis`
- `npm run build`

And keep focused tests for touched modules as regression gates.
