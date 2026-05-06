# IncrementalGraph Database Boot Sequence

## 1) Purpose

Define a deterministic, correctness-first startup protocol for IncrementalGraph database initialization.

The protocol is intentionally fail-fast: it prefers crashing on ambiguous or structurally invalid state over silently starting from a potentially wrong state.

This document specifies **startup behavior only**. It does not specify steady-state synchronization, runtime merge behavior outside boot, or corruption-repair workflows.

For clarity: steady-state sync merge now performs replica cutover only when merge writes actually change data. No-op sync merges keep `_meta/current_replica` unchanged. Migration cutover behavior is unchanged and still always switches because migration updates replica version metadata.

---

## 2) Data model and storage layers

Volodyslav uses two coordinated stores for generators data:

1. **Live LevelDB (authoritative at runtime)**
   - Path: `<workingDirectory>/generators-leveldb`
   - Root metadata includes:
     - `_meta/format`
     - `_meta/current_replica`
   - Replicated graph namespaces: `x` and `y`.

2. **Git-tracked rendered snapshot (synchronization/checkpoint projection)**
   - Path: `<workingDirectory>/generators-database/rendered`
   - Contains filesystem render of active data (`r/`) and metadata (`_meta/`).

The boot protocol decides how the live LevelDB is seeded/opened; the snapshot repository is a synchronization dependency, not the runtime source of truth.

---

## 3) Preconditions, trust assumptions, terminology, and out-of-scope classes

### 3.1 Environment preconditions

1. `VOLODYSLAV_HOSTNAME` is present and valid before startup proceeds.
2. At most one process executes this boot sequence against the same working directory at a time.

### 3.2 Trust assumptions about inputs

1. If the live DB directory exists at boot entry, the protocol assumes it remains structurally readable and non-malformed for the duration of that boot attempt.
2. If `<hostname>-main` exists remotely, the protocol assumes its rendered data is structurally well-formed for the reset/scan/merge path.

### 3.3 Terminology used by this protocol

1. **Live DB exists**: directory existence at `<workingDirectory>/generators-leveldb` only.
2. **Fresh DB**: a newly initialized DB where active replica version metadata is absent.
3. **Current version**: the application version expected by the running build.
4. **Migration checkpoint**: the `checkpointSession`-based write sequence (via `checkpointMigration`) that prepares migrated replica state and records pre/post rendered snapshots.
5. **Replica cutover**: the committed switch of `_meta/current_replica` from old replica to migrated replica.
6. **Fatal startup crash**: startup abort where IncrementalGraph is not exposed.
7. **Structural validation**: boot-time checks for `_meta/format == xy-v2` and `_meta/current_replica ∈ {x,y}`.
8. **Effective version**: the version metadata associated with the active replica after startup completes.

### 3.4 Out of scope

1. Arbitrary corruption detection/repair of malformed local or remote data.
2. Compatibility heuristics that attempt startup continuation after structural-contract violations.

---

## 4) Successful-startup postconditions

If startup completes successfully, all of the following hold:

1. A live LevelDB is present and openable at the runtime storage path.
2. Root format marker is valid (`xy-v2`).
3. Replica pointer is valid (`x` or `y`).
4. Active replica version is current application version (either already current or migrated during startup).
5. IncrementalGraph is exposed only after the above conditions are satisfied.

---

## 5) Conceptual phases

1. **Bootstrap source selection** (only if live DB directory is missing).
2. **Open + structural validation** (format marker + replica pointer).
3. **Version check + migration** (if version mismatch).
4. **Expose initialized graph**.

Each phase addresses one class of risk and does not mix responsibilities.

---

## 6) Boot flow (high-level)

```mermaid
flowchart TD
    A[Startup] --> B{Live DB directory exists?}
    B -->|Yes| C[Open RootDatabase]
    B -->|No| D[Try sync reset_to_hostname=current hostname]
    D --> E{Hostname branch exists remotely?}
    E -->|Yes| C
    E -->|No| F[Fallback: normal sync from empty local DB]
    F --> C

    C --> G{_meta/format == xy-v2?}
    G -->|No| X[Crash]
    G -->|Yes| H{_meta/current_replica in x,y?}
    H -->|No| X
    H -->|Yes| I[Check version and run migration if needed]

    I --> J{Version already current?}
    J -->|Yes| K[No migration]
    J -->|No| L[Run migration checkpoint + replica cutover]

    K --> M[Expose IncrementalGraph]
    L --> M
```

---

## 7) Detailed protocol

### 7.1 Bootstrap when live DB is missing

Trigger: `<workingDirectory>/generators-leveldb` does not exist.

Ordered behavior:

1. Read current hostname (`VOLODYSLAV_HOSTNAME`).
2. Attempt sync with `resetToHostname=<hostname>`.
3. If reset fails specifically because `<hostname>-main` does not exist remotely:
   - run normal sync (no reset) from empty local DB.
4. Any other sync/reset failure is fatal.

### 7.2 Open + structural validation

On open, enforce:

1. Existing DB format marker must be exactly `xy-v2`; otherwise crash.
2. Replica pointer must exist and be one of `x|y`; otherwise crash.
3. Fresh DB initialization writes required root metadata.

### 7.3 Version check + migration

After structural validation:

1. Read active replica version metadata.
2. If no version is recorded (fresh DB), record current version.
3. If version equals current version, continue.
4. If version differs, run migration checkpoint (via `checkpointMigration`) and then perform replica cutover.

### 7.4 Exposure boundary

IncrementalGraph becomes available only after bootstrap/open/validation/migration complete successfully.

---

## 8) Failure semantics

1. **Format mismatch** (`_meta/format != xy-v2`) -> fatal startup crash.
2. **Invalid replica pointer** -> fatal startup crash.
3. **Unexpected reset/sync failure** (non-"hostname branch absent") -> fatal startup crash.
4. **Migration failure** -> fatal startup crash.

### Scope of consistency claim on migration failure

This document claims consistency at the **live RootDatabase boundary**, specifically:

1. active replica pointer (`_meta/current_replica`),
2. committed contents of the active replica namespace, and
3. version metadata used for subsequent boot decisions.

Migration/cutover guarantees are **restart-safety guarantees** around named cut-points, not a blanket claim of atomic rollback for every external side effect.

The following are outside this guarantee boundary unless explicitly covered by the same checkpoint/cutover path:

- rendered snapshot refresh work,
- git-visible checkpoint/update side effects,
- observability-only emissions.

---

## 9) Crash / restart semantics at important cut-points

This protocol is restart-safe by re-running deterministic checks from the beginning.

1. **Crash after reset-to-hostname success, before DB open**
   - Next start sees live DB present and proceeds to open/validate/version-check.

2. **Crash after fallback normal sync success, before DB open**
   - Next start follows same path as above (open/validate/version-check).

3. **Crash during migration checkpoint before replica cutover commit**
   - Active replica pointer remains at old replica; next start retries migration path.

4. **Crash after replica cutover commit, before follow-up side effects**
   - New replica is active on next start; startup continues from structural/version checks.
   - Follow-up side effects in this context are limited to rendered snapshot refresh, git-visible checkpoint updates, and observability emissions.

5. **Crash after successful migration, before interface exposure**
   - Next start re-checks state; version already current, no re-migration needed.

---

## 10) Observability requirements (inspectability contract)

A compliant implementation must emit enough structured log information to reconstruct these facts for every startup attempt:

1. Whether live DB directory existed at startup.
2. Chosen bootstrap path (none/reset/fallback).
3. Whether reset-to-hostname was attempted.
4. Whether fallback was taken and exact reason.
5. Detected format marker result.
6. Detected replica pointer result.
7. Detected active version and current app version.
8. Whether migration ran.
9. Whether cutover was committed and the final active replica/effective version.
10. Final startup result (success/fatal) and error class when failed.

---

## 11) Verification matrix

| ID | Scenario | Expected result |
|---|---|---|
| V1 | Live DB exists, valid, current version | Startup succeeds without migration |
| V2 | Live DB exists, valid, old version | Migration runs, then startup succeeds |
| V2b | Fresh DB (no version recorded yet) | Current version is recorded without migration, then startup succeeds |
| V3 | Live DB missing, hostname branch exists | Reset bootstrap path used, then open/validate/migrate as needed |
| V4 | Live DB missing, hostname branch absent | Fallback normal sync path used, then open/validate/migrate as needed |
| V5 | Live DB exists, format mismatch | Fatal crash before graph exposure |
| V6 | Live DB exists, invalid replica pointer | Fatal crash before graph exposure |
| V7 | Live DB missing, reset path fails for unexpected reason | Fatal crash |
| V7b | Live DB exists but malformed (assumption violation) | Fatal crash path is explicit; classification recorded as assumption violation |
| V7c | Hostname branch exists but rendered data malformed (assumption violation) | Fatal crash path is explicit; classification recorded as assumption violation |
| V8 | Migration fails before cutover commit | Fatal crash; previous active replica remains active |
| V9 | Migration fails after cutover commit, before follow-up side effects | Fatal crash; new replica remains active on restart |
| V9b | Migration succeeds but rendered/git follow-up fails | Startup result matches restart-safe boundary; next boot deterministically re-evaluates |
| V10 | Repeated restarts at each crash cut-point | Deterministic re-entry into protocol (no silent success from wrong state) |

---

## 12) Why this protocol is chosen

1. Prefers startup refusal over compatibility heuristics when structural contracts are violated.
2. Prefers a narrow, auditable decision tree over flexible recovery logic.
3. Separates bootstrap concerns from structural validation and migration/cutover boundaries.
4. Accepts explicit trust assumptions on local/remote storage shape to keep boot logic simple.
5. Intentionally does not attempt self-healing from malformed inputs.

---

## 13) Implementation touchpoints

These touchpoints are informative and do not define protocol semantics.

- `backend/src/generators/interface/lifecycle.js` (startup orchestration boundary)
- `backend/src/generators/incremental_graph/database/root_database.js` (format/pointer checks)
- `backend/src/generators/incremental_graph/migration_runner.js` (version/migration behavior)
- `backend/src/generators/incremental_graph/database/gitstore.js` (migration snapshot/checkpoint integration)
- `backend/src/generators/incremental_graph/database/synchronize.js` (bootstrap sync behaviors)

---

## 14) Non-goals

1. Supporting legacy format markers (for example `xy-v1`).
2. Soft recovery from format mismatch.
3. General corruption-repair workflow for malformed local/remote data.
4. Expanding bootstrap fallback beyond the single explicit missing-hostname-branch condition.
