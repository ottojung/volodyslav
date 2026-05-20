# PR #1335 Review 1 — Problem Analysis

## Feedback summary
Review feedback identified that `backend/tests/database_render.test.js` had most of its coverage removed during refactoring. That is risky because this suite guards the DB↔filesystem contract that PR #1335 changed.

## What was wrong
After restoring the test file to commit `7e6adcf7314ee8b2b8e144cb7dffdd951d48ab5d` and running the suite, failures clustered around one root issue:

- `keyToRelativePath()` no longer treated NodeKey sublevels specially.
- `relativePathToKey()` no longer reconstructed NodeKey JSON for NodeKey sublevels.

That regression caused many downstream failures:
- human-readable path expectations broke
- bijection tests failed
- render-to-filesystem expectations failed
- invalid-key rejection behavior disappeared

## Root cause
The active implementation had effectively flattened identifier sublevels into plain string pass-through behavior, bypassing NodeKey serialization/deserialization logic. In other words, a refactor removed semantic decoding rather than just reorganizing code.

## Risk profile
High risk for:
- snapshot compatibility
- migration confidence
- refactor safety

Because this encoding boundary is foundational, losing tests and weakening logic can create silent data-shape drift.
