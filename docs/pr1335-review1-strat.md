# PR #1335 Review 1 — Strategy

## Strategy principles

1. **Invariants first, implementation second**
   - Explicitly codify contracts before further code movement.

2. **Minimize hidden coupling**
   - Keep cross-module coupling deliberate and documented.

3. **Make correctness observable**
   - Every critical invariant must map to one or more focused tests.

4. **Prefer incremental hardening over broad rewrites**
   - Target highest-risk ambiguity first.

## Strategic goals

### Goal 1: Improve approachability
Produce a single reader-friendly explanation of the final architecture and data flow.

### Goal 2: Reduce design ambiguity
Document and enforce the most important contracts at module boundaries.

### Goal 3: Raise confidence in future evolution
Add tests and diagnostic behavior that catch invariant violations early.

## Chosen tactical direction for this round
For this review cycle, focus on one high-leverage area:

- **Identifier lookup persistence contract** in root database APIs.

Reason:
- It is central to the PR’s identifier-native model.
- Small ambiguity here can cause systemic drift.
- It can be hardened with minimal architectural disruption.

## Success criteria

- A reviewer can answer, in under 5 minutes:
  1. Where identifier lookup lives.
  2. What “missing vs malformed” lookup states mean.
  3. How those states influence startup/migration behavior.

- Tests continue to pass and no existing behavior is accidentally widened.
