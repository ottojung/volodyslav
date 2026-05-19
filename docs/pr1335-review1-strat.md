# Strategy to address Review 1 (atomicity of replica switch)

## Principles

1. **Fail-before-commit**
   - Any operation that can fail while preparing the target active replica must happen *before* writing `_meta/current_replica`.

2. **Single commit point**
   - Durable cutover (`_meta/current_replica`) should be the final irreversible step.

3. **No partial observable success**
   - On thrown error, caller must observe no pointer switch and unchanged in-memory active state.

4. **Replica-local data loading without global mutation**
   - Build target identifier lookup from explicit target replica sublevel, not via `currentReplicaName()`.

## Strategic design

Introduce a staged switch algorithm:

- Stage A (validation/preparation):
  - Validate `name` is replica literal `x|y`.
  - Load identifier lookup from target replica *without mutating* current active state.

- Stage B (commit):
  - Persist `_meta/current_replica = name`.
  - Update in-memory `_cachedValueOfCurrentReplica = name`.
  - Swap `_identifierLookup` to prepared lookup.

Only Stage B mutates shared active state; Stage A must be pure/read-only from active-switch perspective.

## Error model

- Any Stage A failure => throw `SwitchReplicaError`; old durable pointer and old in-memory state remain intact.
- Stage B write failure => throw `SwitchReplicaError`; old state remains intact.
- After successful write, in-memory assignment operations are synchronous and should not fail under normal semantics.

## Verification strategy

1. Add/adjust targeted tests to prove throw-path preserves old pointer.
2. Retain existing success tests for immediate in-memory update and persistence across reopen.
3. Run focused tests first, then full suite, static analysis, and build.

## Why this addresses the review directly

The reported non-atomicity comes from pointer write before readiness check. Preloading target lookup first removes that ordering hazard, so cutover is only committed once target runtime state is proven loadable.
