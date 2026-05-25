# PR #1335 Review 1 — Detailed Problem Statement

## What the feedback asks for
The feedback asks for three things simultaneously:

1. A very approachable explanation.
2. Clear discussion of questionable decisions.
3. Extra guidance to steer next development steps.

The current PR state (as inferred from commit history and touched paths) makes this hard because the implementation is broad and the rationale is fragmented across many patch iterations.

## Core problem
The PR attempts to solve real correctness issues (identifier-native persistence and volatile/persistent consistency), but its **presentation and decomposition** are currently too difficult to reason about quickly.

This creates three concrete problems for reviewers and maintainers:

### Problem A — Reviewability debt
- Too many concerns changed together (storage model, migration, sync/replica behavior, runtime consistency).
- Iterative fix commits obscure the final intended design contract.

Impact:
- Higher chance of approving changes without fully understanding invariants.
- Harder to detect subtle regressions.

### Problem B — Invariant discoverability is low
The most important system invariants are not centralized enough:
- What is the single source of truth for node identity?
- Exactly which writes must be in one atomic batch?
- What guarantees must hold before/after replica pointer switch?
- What ordering assumptions exist for nested pull contexts?

Impact:
- Future changes may accidentally violate implicit assumptions.
- Tests may pass while design drifts from intended model.

### Problem C — Migration and reconciliation confidence gap
There are many migration-oriented changes and fixture updates, indicating risk around legacy-state conversion.

Impact:
- Even if current tests are green, confidence is reduced unless migration contracts are explicit and independently verifiable.

## Questionable decisions worth revisiting

1. **Large-scope PR with repeated corrective commits**
   - This is understandable in exploratory refactoring, but it weakens the final review signal.

2. **Implicit coupling between resolver and persistence internals**
   - Co-locating identifier-map and node-write atomicity is likely correct, but coupling boundaries need explicit architectural explanation.

3. **Concurrency fixes late in series**
   - Nested async context ordering bugs are usually systemic, not local; they deserve explicit invariant docs + targeted stress tests.

## Information needed to steer development better

### 1) Canonical invariants document
A short document should define:
- Identity invariants.
- Atomicity invariants.
- Replica switch invariants.
- Volatile/persistent consistency invariants.

### 2) Focused test matrix by invariant
Tests should be grouped by invariant category rather than by implementation module alone.

### 3) “Failure mode catalog”
For each invariant, define expected detection and recovery behavior.

This would make future review rounds faster and less ambiguous.
