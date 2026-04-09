# Report 1 — Bug Understanding (Incremental Graph Boot Sequence)

## Context reconstructed from the provided logs

The failing startup path was:

1. startup entered bootstrap reset flow (`synchronizeNoLock(..., { resetToHostname })`),
2. code reached snapshot `_meta/current_replica` parsing,
3. threw `InvalidSnapshotReplicaError` with value shown as quoted `"undefined"`,
4. process crashed,
5. restart succeeded unexpectedly.

The remote snapshot had `_meta/format = "xy-v1"` (legacy / incompatible).

## Bug A: Validation order violates boot-sequence spec

The boot specification requires format validation before replica validation (`_meta/format` must be exactly `xy-v2`, then `_meta/current_replica` must be one of `x|y`).

Observed behavior validated `_meta/current_replica` first in reset bootstrap transaction, without first checking snapshot `_meta/format`.

### Why this is harmful

- It can misclassify root cause (reports replica-pointer problem while format is actually incompatible).
- It can produce misleading diagnostics and wrong remediation direction.
- It violates deterministic startup decision tree in `docs/database-boot-sequence.md`.

## Bug B: Error rendering bug for undefined values

`InvalidSnapshotReplicaError` formatted values as `"${String(value)}"`.

For `undefined`, this produces `"undefined"` (quoted string representation), which is semantically misleading because the runtime value is not the string `"undefined"`; it is the absence of a value.

## Bug C (severe): Failed reset bootstrap leaves behind a locally initialized live DB

The previous flow opened/initialized live LevelDB (`getRootDatabase`) before snapshot compatibility checks in reset mode.

On a fresh live DB, `makeRootDatabase` writes default root metadata (`_meta/format = xy-v2`, `_meta/current_replica = x`). Therefore, even if reset bootstrap later fails due to remote snapshot incompatibility, local live DB artifacts can already exist.

On restart, startup sees live DB directory present and takes "open existing DB" path instead of reset bootstrap path. If local metadata looks structurally valid, startup can continue — effectively masking original bootstrap failure and violating fail-fast semantics.

## Spec violation summary

This behavior violates explicit protocol requirements:

- "format mismatch -> fatal startup crash" before replica checks,
- deterministic re-entry on restart at crash cut-points,
- no silent recovery from structural contract violations.

## Root-cause summary

The defects are coupled:

1. wrong check ordering in reset snapshot ingestion,
2. misleading message formatting for undefined,
3. side effects (local DB initialization) occurring before compatibility gate.

Together they explain both bad crash message and non-deterministic post-crash restart success.
