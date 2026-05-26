# PR #1335 Review 1: Remediation Strategy

## Strategy principles

1. **Correctness first**: retain disk-first identifier lookup persistence and no lost-update behavior.
2. **Spec alignment second**: implement lock granularity that matches graph activity and per-node pull semantics.
3. **Locality**: isolate locking changes primarily to lock/pull/transaction infrastructure.
4. **Prove by tests**: concurrency tests must encode the required semantics directly.

## Strategic approach

### Step 1: Separate concerns in locking
Split "graph phase exclusion" from "identifier allocation safety":
- keep graph-phase locking via mode mutex (`observe`/`pull`/`exclusive`),
- avoid using allocation-safety lock as a blanket transaction lock.

### Step 2: Add explicit per-node pull exclusion
Introduce a lock primitive/key family for per-node pulls and acquire it in pull path so same-node pulls serialize while different-node pulls can proceed.

### Step 3: Minimize serialized region for identifier allocation
Limit strict serialization to the critical section that reads/modifies/persists identifier allocation state, not entire pull computation.

### Step 4: Preserve transaction explicitness
Keep explicit transaction propagation for nested pulls; avoid hidden context.

### Step 5: Validate with focused then full checks
- focused concurrency tests,
- migration and identifier-map tests,
- full `npm test`, `npm run static-analysis`, `npm run build`.

## Risk controls

- Deadlock risk: keep deterministic acquisition order and avoid lock upgrades.
- Regression risk: avoid changing graph API behavior, only lock boundaries and tests.
- Migration risk: do not alter persisted format semantics in this lock-focused remediation.
