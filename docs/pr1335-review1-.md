# PR #1335 Review 1: Problem statement

## Review thread
Feedback source: `pullrequestreview-4323287876` in PR #1335.

## Core problem
The review identifies an architectural regression risk: storage-layer purity was not fully preserved and quality guardrails (documentation density, test retention, clean analysis/test status) were not consistently maintained during refactor iterations.

## Detailed problem breakdown

### 1) Storage boundary contamination
`graph_storage.js` must be an identifier-native persistence module. Any direct dependence on semantic key concepts (`NodeKey`, `NodeKeyString`, `head + args`) violates the intended layering and increases repeated conversion churn.

### 2) Documentation regression
Some iterations removed explanatory typedefs/comments. In this codebase, JSDoc contracts are first-class type infrastructure; losing them materially harms maintainability and type-checking clarity.

### 3) Test removal as a refactor anti-pattern
Deleting tests to pass a transition is specifically disallowed by review policy. Behavior must be preserved (or intentionally improved) with equivalent/stronger coverage.

### 4) Validation drift
The branch needed reconciliation with `npm test` and `npm run static-analysis` so architectural changes are not accepted with latent correctness/tooling failures.

## Why this matters
Identifier migration is not only data-format work; it is an invariants exercise. If layering or coverage regresses, the migration can appear successful while hiding correctness regressions in dependency indexing, snapshot restoration, or stale-graph invalidation flows.
