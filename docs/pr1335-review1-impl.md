# PR #1335 Review 1 — Implementation Plan

## Scope
- Restore removed test coverage.
- Repair encoding behavior to satisfy restored tests.
- Run full validation checks.

## Detailed plan

1. **Reset test file**
   - Command: `git checkout 7e6adcf7314ee8b2b8e144cb7dffdd951d48ab5d -- backend/tests/database_render.test.js`
   - Confirm restored file is staged as modified.

2. **Reproduce failures**
   - Run: `npx jest backend/tests/database_render.test.js`
   - Record failing groups and identify shared failing module.

3. **Patch encoding module**
   - File: `backend/src/generators/incremental_graph/database/encoding.js`
   - Ensure NodeKey-specific conversion path exists in both directions.
   - Ensure plain-key behavior is constrained to plain sublevels only.
   - Preserve guardrails for invalid NodeKey payloads.

4. **Re-run focused tests**
   - Run: `npx jest backend/tests/database_render.test.js`
   - Require all tests pass before broad checks.

5. **Run repository validation pipeline**
   - `npm test`
   - `npm run static-analysis`
   - `npm run build`

6. **Finalize**
   - Verify clean intent in `git diff`.
   - Commit changes with message summarizing restored coverage and encoding fix.
