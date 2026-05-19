# PR #1335 Review 1: Implementation plan

## 1) Affected-path audit
- Inspect incremental graph runtime + storage + migration modules.
- Verify that semantic-key handling lives in resolver/migration boundaries, not persistence internals.

## 2) Storage contract enforcement
- Keep/ensure `GraphStorage` API operates on `NodeIdentifier` values and arrays.
- Preserve batch overlay behavior (pending puts/dels) with deterministic key ordering.

## 3) Documentation restoration
- Ensure typedefs describe each database bucket and batch operation contract.
- Add concise but meaningful function-level comments where behavior is subtle (ordering, overlay precedence, migration edge-cases).

## 4) Test alignment
- Run focused incremental-graph tests.
- If a test fails due legitimate API modernization, rewrite it to assert equivalent external behavior rather than deleting coverage.

## 5) Full verification and stabilization
- Run `npm run static-analysis`.
- Run `npm test`.
- Run `npm run build`.
- Resolve failures with minimal, principled changes.

## 6) Deliverables
- Documentation set:
  - `docs/pr1335.md`
  - `docs/pr1335-review1-.md`
  - `docs/pr1335-review1-strat.md`
  - `docs/pr1335-review1-impl.md`
- Code changes implementing any identified gaps.
