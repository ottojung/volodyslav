# PR #1335 Review #1 — Detailed feedback digest

## Friendly intro
If you just want the short version: this PR is directionally good and ambitious, but it moved a lot of foundational pieces at once. The resulting system is much more powerful, yet easier to accidentally desynchronize.

Think of it as replacing street addresses with internal customer IDs across an entire city map. Great long-term, but every import/export, merge, and migration now depends on that ID directory being perfect.

## What is excellent
- The architecture now has a clear concept of persisted node identity.
- Migration and sync are treated as first-class flows, not afterthoughts.
- Many sharp review comments already identified and fixed truly serious correctness bugs.

## Questionable design choices (and why they matter)

### 1) Semantic key vs persisted identifier boundaries are still cognitively expensive
Even where code is correct, naming and typing still make it easy for maintainers to feed semantic keys where identifiers are expected (and vice versa).

Impact:
- harder onboarding,
- increased chance of subtle bugs in future refactors,
- confusing error surfaces when data is damaged or partially migrated.

### 2) Lookup correctness relies on discipline across many call sites
The identifier bijection is global and critical, but updates are spread across pull, sync, migration, and transaction commit paths.

Impact:
- easy for a future optimization to accidentally bypass invariant-preserving helpers,
- invariants are not yet enforced by one obvious “single write authority” boundary.

### 3) Replica cutover semantics are still fragile to operation ordering
Several review findings show how easy it is to switch replica pointers too early/late relative to metadata and lookup persistence.

Impact:
- stale reads in-process,
- snapshot/checkpoint mismatch,
- hard-to-debug state divergence across restarts.

## Core problem statement
The PR succeeded at introducing identifier-native persistence, but the system still needs a **more explicit invariant-driven contract**:

1. What values are semantic keys?
2. What values are persisted identifiers?
3. When (and only when) can conversion happen?
4. Which operations atomically update both data and lookup?
5. Which failure paths must preserve rollback safety?

Without those contracts being obvious and hard to violate, every future change will re-open the same risk class.

## Information to steer further development
- Treat identifier-lookup updates as critical-section logic, not incidental bookkeeping.
- Prefer APIs that force callers to choose semantic-key or identifier-specific methods explicitly.
- Add focused regression tests for concurrency + cutover + migration-created-node mapping completeness.
- Improve developer docs around invariants before further performance work.
