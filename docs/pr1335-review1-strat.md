# PR #1335 Review 1: Strategy

## Principles
1. **Single responsibility boundaries**: storage module stays identifier-only.
2. **Conversion locality**: perform key→identifier lookup once at external API boundaries, then propagate identifiers.
3. **Behavior-preserving refactor**: restore or rewrite tests equivalently; never reduce protection for failing flows.
4. **Type-documentation parity**: every exported behavior and non-trivial type gets meaningful JSDoc.
5. **Validation first-class**: static-analysis and test suites are release gates.

## Strategy steps

### Step A — Reconstruct architecture intent
Map IncrementalGraph call paths and mark where semantic keys enter the system. Define the single allowed transition points into identifier-native execution.

### Step B — Enforce storage purity
Audit `graph_storage.js` and dependent contracts to ensure only `NodeIdentifier`-keyed operations exist there. Remove semantic-key notions from that layer.

### Step C — Repair docs/types quality
Re-introduce structured typedef blocks and focused comments for batch semantics, storage contracts, and invariants.

### Step D — Recover/strengthen coverage
Restore removed tests or rewrite equivalent tests against updated interfaces. Prioritize migration correctness, reverse-dep integrity, and read-your-writes behavior.

### Step E — Close validation loop
Run targeted tests, then full `npm test`, `npm run static-analysis`, and `npm run build`. Fix root causes rather than muting checks.
