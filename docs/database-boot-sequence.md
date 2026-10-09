# IncrementalGraph Database Boot Sequence

## 1) Purpose

Define a deterministic, correctness-first startup protocol for IncrementalGraph database initialization under the Journal model.

The protocol is intentionally fail-fast: it prefers crashing on ambiguous or structurally invalid state over silently starting from a potentially wrong state.

This document specifies **startup behavior only**. It does not specify steady-state synchronization, runtime merge behavior outside boot, or corruption-repair workflows.

The lifecycle rules this protocol implements are normative in `database-lifecycle.md`.

---

## 2) Data model and storage layers

Volodyslav persists IncrementalGraph state in one live database:

1. **Live database (authoritative at runtime)**
   - Path: `<workingDirectory>/generators-leveldb`
   - Root metadata includes:
     - `global/version` — the one persisted format selector for the active replica
     - `global/graph_scheme` — the active graph scheme string
   - Journal sublevels hold the retained immutable record history.
   - Graph sublevels hold the materialized projection `project(Journal)`.

2. **Synchronization transport (checkpoint projection)**
   - The configured synchronization repository carries stable database snapshots.
   - A snapshot is a synchronization dependency, not the runtime source of truth.

The boot protocol decides how the live database is opened, restored, or created; the transport is a synchronization dependency, not the runtime source of truth.

---

## 3) Preconditions, trust assumptions, terminology, and out-of-scope classes

### 3.1 Environment preconditions

1. Required environment configuration is present and valid before startup proceeds.
2. At most one process executes this boot sequence against the same working directory at a time.

### 3.2 Trust assumptions about inputs

1. If the live database exists at boot entry, the protocol assumes it remains structurally readable and non-malformed for the duration of that boot attempt.
2. Participating installations are non-adversarial but may be stale, interrupted, offline, delayed, or incompatible.

### 3.3 Terminology used by this protocol

1. **Live database exists**: a supported local database is present at the runtime storage path.
2. **Absent**: no supported local database/writer identity is present locally, including after complete loss of the local database.
3. **Current version**: the database version expected by the running build.
4. **Committed pair**: the atomically published `(retained journal, materialized projection)` selected by `global/version`.
5. **Fatal startup crash**: startup abort where IncrementalGraph is not exposed.
6. **Routine open**: the bounded `O(1 + G)` open of an already-current supported database, which does not replay retained history.
7. **Effective version**: the version metadata associated with the active pair after startup completes.

### 3.4 Out of scope

1. Arbitrary corruption detection/repair of malformed local or remote data.
2. Compatibility heuristics that attempt startup continuation after structural-contract violations.

---

## 4) Successful-startup postconditions

If startup completes successfully, all of the following hold:

1. A live database is present and openable at the runtime storage path.
2. The active committed pair is valid and identifies current version/schema.
3. Active database version is current application version (either already current, restored, bootstrapped, or migrated during startup).
4. IncrementalGraph is exposed only after the above conditions are satisfied.

---

## 5) Conceptual phases

1. **Existence decision** (absent-state decision only if the local database is completely absent).
2. **Open + structural validation** (committed-pair metadata).
3. **Migration/bootstrap gate** (if version/schema require a transition).
4. **Expose initialized graph**.

Each phase addresses one class of risk and does not mix responsibilities.

---

## 6) Boot flow (high-level)

```mermaid
flowchart TD
    A[Startup] --> B{Supported local database present?}
    B -->|No| C[Query InstallationRecoverySource]
    C --> D{Source result}
    D -->|Exists(ContinuationSafeSnapshot)| E[Receiver-less restore]
    D -->|DefinitelyAbsent| F[Fresh creation]
    D -->|IndeterminateOrError| X[Crash]
    E --> G[Open + structural validation]
    F --> G
    B -->|Yes| G

    G --> H{Committed-pair metadata valid?}
    H -->|No| X
    H -->|Yes| I[Migration/bootstrap gate]

    I --> J{Stored version}
    J -->|Current| M[Expose IncrementalGraph]
    J -->|Supported older Journal version| L[Journal-aware migration]
    J -->|Pre-Journal| N[Canonical bootstrap]
    J -->|Unsupported / no chain| X
    L --> M
    N --> M
```

---

## 7) Detailed protocol

### 7.1 Absent-state decision when the live database is missing

Trigger: no supported local database is present at the runtime storage path.

This decision happens **before generating a new DatabaseFingerprint**.

Ordered behavior:

1. Query the transport-neutral `InstallationRecoverySource` for this installation.
2. The source answers exactly one of:
   - **`Exists(ContinuationSafeSnapshot)`** — open/hold that source's stable database snapshot and restore it through the receiver-less restore path (`database-lifecycle.md` §4.2). The held snapshot must establish a continuation-safe head before this installation may author another record under that writer.
   - **`DefinitelyAbsent`** — fresh creation is allowed. Generate one new durable `DatabaseFingerprint`, start at local writer frontier zero, retain no foreign history, materialize an empty graph, and record current version/schema metadata.
   - **`IndeterminateOrError`** — startup fails. Failure to query or obtain known synchronized state MUST NOT fall back to fresh creation.

3. Any query/read failure or indeterminate result is fatal.

There is no `resetToHostname` attempt and no fallback to normal synchronization from an empty local database. An existing but damaged, truncated, or older local database does not enter this path; it is corrupted/unsupported.

### 7.2 Open + structural validation

On open, enforce:

1. The active committed-pair metadata (`global/version`, `global/graph_scheme`) must be present and valid; otherwise crash.
2. Routine open of an already-current supported database performs only the bounded checks of `database-lifecycle.md` §6: current version/schema compatibility, constant-size/current-state metadata, local writer head, allocator watermark, authority high-water, and current graph/index consistency work bounded by G. It does not replay retained history.
3. Missing or inconsistent committed-pair metadata causes startup failure or an explicit supported maintenance/rebuild transition; it does not trigger a silent full-history routine-open scan.

### 7.3 Migration/bootstrap gate

After structural validation, follow the gate of `database-lifecycle.md` §8:

1. Read stored database version.
2. If the stored version matches the current Journal version, continue.
3. If the stored version is a supported older Journal version, resolve and execute the canonical Journal migration chain from that stored version to the running version.
4. If the stored version is an older Journal version without a complete canonical chain to the running version, fail `JournalVersionCompatibilityError`.
5. If the stored version is unsupported, fail.
6. If the state is a supported pre-Journal database, run the canonical-bootstrap-source decision (`database-lifecycle.md` §8.2): the canonical bootstrap artifact must be selected and published before any local Journal cutover or ordinary Journal authoring. An unresolved publication outcome leaves the supported pre-Journal database selected and startup fails before graph APIs are exposed.
7. Absence of stored version is treated as fresh only under genuine fresh-creation rules; it does not erase structured existing state whose metadata is malformed/missing.

### 7.4 Exposure boundary

IncrementalGraph becomes available only after the absent-state decision (if any), open/structural validation, and the migration/bootstrap gate complete successfully.

---

## 8) Failure semantics

1. **Indeterminate or failed recovery-source query** -> fatal startup crash; no fresh fallback.
2. **Invalid committed-pair metadata** -> fatal startup crash or explicit supported maintenance transition.
3. **Unsupported version or incomplete migration chain** -> fatal startup crash (`JournalVersionCompatibilityError`).
4. **Unresolved canonical bootstrap publication** -> fatal startup crash; the supported pre-Journal database remains selected.
5. **Migration failure** -> fatal startup crash; the previous active pair remains selected.

### Scope of consistency claim on migration failure

This document claims consistency at the **live database boundary**, specifically:

1. the active committed-pair metadata (`global/version`),
2. committed contents of the active Journal/projection pair, and
3. version metadata used for subsequent boot decisions.

Migration/cutover guarantees are **restart-safety guarantees** around named cut-points, not a blanket claim of atomic rollback for every external side effect.

The following are outside this guarantee boundary unless explicitly covered by the same cutover path:

- rendered snapshot refresh work,
- git-visible checkpoint/update side effects,
- observability-only emissions.

---

## 9) Crash / restart semantics at important cut-points

This protocol is restart-safe by re-running deterministic checks from the beginning.

1. **Crash after receiver-less restore success, before DB open**
    - Next start sees the live database present and proceeds to open/validate/migrate.

2. **Crash after fresh creation success, before DB open**
    - Next start follows the same path as above (open/validate/migrate).

3. **Crash during Journal-aware migration before cutover commit**
    - The active pair remains the previous one; next start retries the migration path.

4. **Crash after cutover commit, before follow-up side effects**
    - The new pair is active on next start; startup continues from structural/version checks.
    - Follow-up side effects in this context are limited to rendered snapshot refresh, git-visible checkpoint updates, and observability emissions.

5. **Crash after successful migration, before interface exposure**
    - Next start re-checks state; version already current, no re-migration needed.

6. **Crash during canonical bootstrap publication**
    - The supported pre-Journal database remains selected; next start re-queries/resolves the canonical artifact through the owned procedure before another publication attempt or cutover.

---

## 10) Observability requirements (inspectability contract)

A compliant implementation must emit enough structured log information to reconstruct these facts for every startup attempt:

1. Whether a supported local database existed at startup.
2. Chosen bootstrap path (none/restore/fresh).
3. The recovery-source query result (exists/definitely-absent/indeterminate-or-error).
4. Detected committed-pair metadata result.
5. Detected stored version and current app version.
6. Whether the migration/bootstrap gate ran and which transition it selected.
7. Whether a cutover was committed and the final active pair/effective version.
8. Final startup result (success/fatal) and error class when failed.

---

## 11) Verification matrix

| ID | Scenario | Expected result |
|---|---|---|
| V1 | Live database exists, valid, current version | Startup succeeds without migration |
| V2 | Live database exists, valid, old Journal version | Journal-aware migration runs, then startup succeeds |
| V2b | Fresh database (no version recorded yet) | Current version is recorded without migration, then startup succeeds |
| V3 | Live database missing, recovery source returns Exists(ContinuationSafeSnapshot) | Receiver-less restore path used, then open/validate/migrate as needed |
| V4 | Live database missing, recovery source returns DefinitelyAbsent | Fresh creation path used, then open/validate as needed |
| V5 | Live database exists, committed-pair metadata invalid | Fatal crash before graph exposure |
| V6 | Live database missing, recovery source returns IndeterminateOrError | Fatal crash; no fresh fallback |
| V7 | Live database exists, unsupported version | Fatal crash (`JournalVersionCompatibilityError`) |
| V7b | Live database exists but malformed (assumption violation) | Fatal crash path is explicit; classification recorded as assumption violation |
| V7c | Recovery source snapshot malformed (assumption violation) | Fatal crash path is explicit; classification recorded as assumption violation |
| V8 | Migration fails before cutover commit | Fatal crash; previous active pair remains active |
| V9 | Migration fails after cutover commit, before follow-up side effects | Fatal crash; new pair remains active on restart |
| V9b | Migration succeeds but rendered/git follow-up fails | Startup result matches restart-safe boundary; next boot deterministically re-evaluates |
| V10 | Repeated restarts at each crash cut-point | Deterministic re-entry into protocol (no silent success from wrong state) |
| V11 | Pre-Journal database, canonical bootstrap artifact exists | Creator-resume or join completes before graph exposure |
| V12 | Pre-Journal database, canonical bootstrap publication indeterminate | Fatal crash; pre-Journal database remains selected |

---

## 12) Why this protocol is chosen

1. Prefers startup refusal over compatibility heuristics when structural contracts are violated.
2. Prefers a narrow, auditable decision tree over flexible recovery logic.
3. Separates the absent-state decision from structural validation and the migration/bootstrap gate.
4. Accepts explicit trust assumptions on local/remote storage shape to keep boot logic simple.
5. Intentionally does not attempt self-healing from malformed inputs.

---

## 13) Implementation touchpoints

These touchpoints are informative and do not define protocol semantics.

- `backend/src/generators/interface/lifecycle.js` (startup orchestration boundary)
- `backend/src/generators/incremental_graph/journal_bootstrap_startup.js` (bootstrap gate routing)
- `backend/src/generators/incremental_graph/journal_bootstrap_gate.js` (migration/bootstrap gate)
- `backend/src/generators/incremental_graph/migration_runner.js` (version/migration behavior)
- `backend/src/generators/incremental_graph/database/synchronize.js` (synchronization behaviors)

---

## 14) Non-goals

1. Supporting legacy committed-pair metadata that does not identify a valid active pair.
2. Soft recovery from structural-contract violations.
3. General corruption-repair workflow for malformed local/remote data.
4. Expanding bootstrap fallback beyond the explicit `InstallationRecoverySource` answers.
