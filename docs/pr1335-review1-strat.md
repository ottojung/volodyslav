# PR #1335 Review 1 — Strategy

## Principles
1. **Preserve behavioral contract first, then refactor.**
2. **Restore test coverage before changing expectations.**
3. **Change production code minimally to satisfy the restored contract.**
4. **Keep conversions explicit at system boundaries.**

## Strategy steps

### Step 1 — Re-establish baseline tests
Restore `backend/tests/database_render.test.js` exactly from `7e6adcf...` to recover full guardrails.

### Step 2 — Use failures as specification
Run only this suite first and categorize failures by contract area:
- key→path mapping
- path→key mapping
- bijection
- rendering integration

### Step 3 — Fix source of truth, not tests
Repair encoding/decoding implementation so:
- NodeKey sublevels parse/emit NodeKey JSON
- plain-key sublevels stay plain
- arg encoding/decoding remains bijective
- invalid NodeKey content fails loudly

### Step 4 — Validate breadth
Run focused suite, then full checks (`npm test`, `npm run static-analysis`, `npm run build`) to ensure no regressions in adjacent modules.

### Step 5 — Document outcomes
Capture what failed, why, and what exact contract was restored, so future refactors keep tests intact.
