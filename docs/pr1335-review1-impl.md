# PR #1335 Review 1 — Detailed Implementation Plan

## Scope of this implementation round

This round implements a narrow, high-value hardening change:

- Make identifier-lookup loading behavior explicit for replica cutover and startup.
- Treat **malformed persisted lookup state** as an error instead of silently converting it to empty.

## Why this implementation

A silent fallback from malformed persisted data to empty lookup can mask corruption or incompatible writes and make debugging difficult.

Failing fast here:
- Protects the identifier-native persistence invariant.
- Keeps replica switch behavior predictable.
- Preserves pointer atomicity by failing before pointer persistence.

## Planned code changes

1. Add a dedicated error class in replica error module:
   - `MalformedIdentifierLookupError`
   - With `isMalformedIdentifierLookupError` type guard.

2. Update `loadIdentifierLookupFromGlobal` in root database:
   - `undefined` => empty lookup (valid fresh state).
   - non-array persisted value => throw `MalformedIdentifierLookupError`.
   - array persisted value => pass to `makeIdentifierLookup` (existing validation path).

3. Add tests in `backend/tests/database.test.js`:
   - Startup fails with `DatabaseInitializationError` whose cause is malformed-lookup error.
   - `setCurrentReplicaPointer` leaves persisted/in-memory pointer unchanged when target replica has malformed lookup record.

## Non-goals

- No redesign of migration runner.
- No changes to sync merge algorithms.
- No changes to transaction semantics beyond malformed-lookup detection.

## Validation plan

- Run focused Jest tests for database behaviors.
- Run project-wide checks required by repository workflow:
  - `npm test`
  - `npm run static-analysis`
  - `npm run build`
