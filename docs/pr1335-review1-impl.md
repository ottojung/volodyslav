# PR 1335 Review 1 Implementation Plan

## Documents

1. Record PR 1335's conceptual and low-level behavior in `docs/pr1335.md`.
2. Record the design strategy in `docs/pr1335-review1-strat.md`.
3. Keep this file as the implementation checklist and audit trail.

## Code changes

1. Extend root active computed state with `inFlightIdentifiers` and `inFlightIdentifierOwners`.
2. Add a synchronous `reserveNodeIdentifier(...)` helper on the root database. It checks committed mappings, in-flight reservations, reserves a fresh candidate, writes the transaction overlay, and records transaction ownership without yielding.
3. Add transaction IDs, `reservedIdentifiers`, and held pull-lock release callbacks to transaction state.
4. Replace the broad computed-state mutex around transaction bodies with a short `withCommitMutex(...)` helper.
5. Add per-node pull locks to the incremental graph and acquire them before resolving/computing a concrete node. Hold them until transaction commit or abort.
6. Replace eager raw batch recording with logical intent maps. Keep read-your-writes semantics for values, freshness, inputs, counters, timestamps, and reverse dependencies.
7. Render absolute node-owned intents and reverse-dependency merge intents under the commit mutex.
8. Rebase identifier overlays under the commit mutex, write the merged full identifier lookup in the same durable batch, publish volatile lookup only after success, and clear reservations in all success/failure paths.
9. Canonicalize dependency identifiers after nested pulls so a transaction that reserved a dependency before another transaction committed it adopts the committed identifier before reading counters or rendering intents.
10. Update tests so the old serialization assertion is replaced by the target disjoint-concurrency behavior, and add coverage for reservation cleanup, duplicate-candidate retry, shared-dependency serialization, and reverse-dependency merges.

## Validation

Run focused incremental graph tests first, then static analysis, full tests, and build. Iterate until all checks pass.
