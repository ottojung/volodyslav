# PR #1335 Review Feedback 1 — Non-atomic replica pointer switch

## Problem statement
`RootDatabaseClass#setCurrentReplicaPointer(name)` performs replica activation in a non-atomic order:

1. Persist `_meta/current_replica = name`.
2. Update in-memory `_cachedValueOfCurrentReplica = name`.
3. Rebuild active identifier lookup via `initializeActiveIdentifierLookup()`.

Because step 1 is committed before readiness of step 3 is known, persistent and runtime state can diverge during failure windows.

## Why this is a correctness issue

The active replica pointer is a durable source of truth used on next boot. If it flips before the process proves it can initialize the new active replica view, then failures can leave a **partially applied cutover**.

### Failure mode A: initialization failure after pointer write
- Persisted pointer says `y`.
- `initializeActiveIdentifierLookup()` throws.
- Caller receives failure, but on-disk state already committed to `y`.
- Runtime may still have stale/partial in-memory state.

### Failure mode B: crash between pointer write and readiness completion
- Pointer is durably switched.
- Process crashes before completing lookup refresh.
- Restart observes switched pointer without evidence that prior process completed switch logic.

## Scope of impact

- **Migration cutover path** via `migration_runner` uses `setCurrentReplicaPointer` as decisive handoff.
- **Sync merge/reset paths** also rely on this method for active replica changes.
- Any consumer assuming “method success/failure cleanly maps to switch applied/not applied” is currently exposed to ambiguity.

## Root cause

The method couples two different transition domains in unsafe order:
- durable metadata transition (`_meta/current_replica` write), and
- runtime readiness transition (load active identifier lookup / update process cache).

These are not currently staged as “validate target state first, then commit pointer + in-memory activation as one final commit step”.

## Desired property

`setCurrentReplicaPointer(name)` should satisfy:
- If it throws, pointer remains on old replica and in-memory state remains old.
- If it succeeds, durable pointer and in-memory active state are both switched and internally consistent.

That gives an atomic API contract at the method boundary even if underlying storage lacks cross-resource transactions.
