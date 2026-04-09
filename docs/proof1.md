# Proof: IncrementalGraph Boot Sequence Implementation Correctness

## 1) Scope

This document proves that the implementation in the following files satisfies the
boot-sequence protocol defined in
`docs/specs/incremental-graph.md` (§ "Database Boot Sequence"):

- `backend/src/generators/interface/lifecycle.js` — startup orchestration
- `backend/src/generators/incremental_graph/database/root_database.js` — format/pointer checks
- `backend/src/generators/incremental_graph/migration_runner.js` — version/migration
- `backend/src/generators/incremental_graph/database/synchronize.js` — bootstrap sync behaviors

---

## 2) Protocol phases and corresponding implementation touchpoints

| Phase | Protocol requirement | Implementation |
|---|---|---|
| Bootstrap source selection | If LevelDB absent: reset-to-hostname if branch exists, else fallback normal sync | `internalBootstrap` in `lifecycle.js` |
| Open + structural validation | `_meta/format == xy-v2`; `_meta/current_replica ∈ {x,y}` | `makeRootDatabase` / `getRootDatabase` in `root_database.js` |
| Version check + migration | Read active version; migrate if mismatch | `runMigrationUnsafe` in `migration_runner.js` |
| Expose initialized graph | Only after all above succeed | `makeIncrementalGraph` called in `internalEnsureInitializedWithMigration` |

---

## 3) Configuration matrix: remote × local state at boot

The following matrix enumerates all meaningful combinations of remote and local state
when the live LevelDB directory is absent (i.e., the bootstrap path is triggered).

Let:
- **H** = hostname branch (`<hostname>-main`) exists on remote
- **L** = local checkpoint repo (`generators-database`) exists
- **O** = local checkpoint repo has `origin` remote configured

### 3.1 LevelDB absent (bootstrap path taken)

| H | L | O | Boot path | Implementation |
|---|---|---|---|---|
| Yes | Yes | Yes | V3: `synchronizeNoLock({ resetToHostname })` | `internalBootstrap` → reset-to-hostname sync; `checkpointDatabase` uses existing local repo; `synchronize` calls `fetchAndReconcile` + `push` |
| Yes | Yes | No | V3: `synchronizeNoLock({ resetToHostname })` | Same reset path; `needsRemoteSetup=true` → add origin, `fetchAndReconcile(resetToHostname)` + `push` |
| Yes | No  | — | V3: `synchronizeNoLock({ resetToHostname })` | `cloneAndConfigureRepository({ resetToHostname: hostname })` clones with `--branch=<hostname>-main` |
| No  | Yes | Yes | V4: init (no-op) + add-origin (no-op) + `synchronizeNoLock()` | `internalInitCheckpointRepoForFallback` is a no-op; `synchronize` → `pull`(returns early, branch absent) + `push`(creates branch) |
| No  | Yes | No  | V4: init (no-op) + add origin + `synchronizeNoLock()` | `internalInitCheckpointRepoForFallback` adds origin; `synchronize` → `pull`(returns early) + `push`(creates branch) |
| No  | No  | — | V4: init repo + add origin + `synchronizeNoLock()` | `internalInitCheckpointRepoForFallback` creates repo + adds origin; `synchronize` → `pull`(returns early) + `push`(creates branch) |

**Key invariant**: after `internalInitCheckpointRepoForFallback`, the local checkpoint repo
always exists and always has `origin` configured. Therefore `workingRepository.synchronize`
never tries to clone the remote for the V4 fallback path, regardless of whether
the local checkpoint existed beforehand.

### 3.2 LevelDB present (no bootstrap)

Bootstrap is skipped entirely; normal boot proceeds directly to phase 2 (open + structural validation).

---

## 4) Proof that each protocol step is satisfied

### 4.1 Bootstrap source selection (§7.1)

**Claim**: when the live LevelDB is absent, the implementation selects the correct bootstrap path.

**Evidence**:

1. `internalEnsureInitialized` checks `capabilities.checker.directoryExists(liveDbPath)`.
2. If absent, `internalBootstrap` is called.
3. `internalBootstrap` runs `git ls-remote --heads -- <remote> refs/heads/<hostname>-main`.
4. If the remote ref is found (`stdout.trim() !== ''`): `synchronizeNoLock(capabilities, { resetToHostname: hostname })` is called (V3 path).
5. Otherwise: `internalInitCheckpointRepoForFallback` ensures the checkpoint repo is initialized and the origin remote is configured, then `synchronizeNoLock(capabilities)` is called (V4 path).

**Coverage of §7.1.3 failure condition** (protocol §8.3):

Any failure in `ls-remote`, `synchronizeNoLock`, or `internalInitCheckpointRepoForFallback`
propagates as an unhandled rejection out of `internalBootstrap` and then out of
`internalEnsureInitialized`, preventing the graph from being exposed. No error is silenced.

### 4.2 Open + structural validation (§7.2)

**Claim**: after bootstrap (or when LevelDB already exists), `makeRootDatabase` enforces
`_meta/format == xy-v2` and `_meta/current_replica ∈ {x,y}`.

**Evidence**: `root_database.js` raises `FormatMismatchError` (fatal) when the format
marker does not equal `FORMAT_MARKER = "xy-v2"`, and `InvalidReplicaError` (fatal) when
the replica pointer is not `"x"` or `"y"`. Both propagate out of `getRootDatabase`.

### 4.3 Version check + migration (§7.3)

**Claim**: `runMigrationUnsafe` reads the active replica version and either records the
current version (fresh DB) or runs the migration + replica cutover.

**Evidence**: `migration_runner.js` reads `schemaStorageForReplica` on the active replica.
If no version is found, the current application version is written (fresh-DB path).
If the version differs, the migration callback is executed and then `_meta/current_replica`
is atomically updated to the new replica name. All of this runs inside a single
`runMigrationInTransaction` call which is wrapped in a gitstore transaction.

### 4.4 Exposure boundary (§7.4)

**Claim**: `makeIncrementalGraph` is only called after all preceding phases succeed.

**Evidence**: `internalEnsureInitializedWithMigration` calls, in order:
1. `getRootDatabase` (phases 2 validation runs here),
2. `runMigrationProcedure` (phase 3 migration),
3. `makeIncrementalGraph` (only if both of the above complete without throwing).

If any step throws, the database is closed and the error re-thrown, leaving
`interfaceInstance._incrementalGraph` as `null`.

---

## 5) Restart-safety at crash cut-points

| Cut-point | Next-boot behavior | Safe? |
|---|---|---|
| Crash after `internalInitCheckpointRepoForFallback`, before `synchronizeNoLock` | Next boot: LevelDB still absent → bootstrap re-runs; `internalInitCheckpointRepoForFallback` is idempotent (no-op if repo + origin already exist) | ✓ |
| Crash after V3/V4 sync, before `getRootDatabase` | LevelDB now present; next boot skips bootstrap | ✓ |
| Crash during migration transaction, before replica cutover | Active replica pointer unchanged; next boot re-runs migration | ✓ |
| Crash after cutover, before interface exposure | New replica active; next boot sees current version → no re-migration | ✓ |

---

## 6) Verification matrix (from protocol §11)

| ID | Scenario | Implementation outcome |
|---|---|---|
| V1 | Live DB present, valid format, current version | Skips bootstrap; `getRootDatabase` succeeds; no migration; graph exposed ✓ |
| V2 | Live DB present, valid format, old version | Skips bootstrap; migration runs via `runMigrationUnsafe` ✓ |
| V2b | Fresh DB (no version recorded) | Skips bootstrap; `runMigrationUnsafe` records current version; no migration callback ✓ |
| V3 | LevelDB absent, hostname branch exists on remote | `internalBootstrap` → reset-to-hostname `synchronizeNoLock`; LevelDB restored; open/validate/migrate ✓ |
| V4 | LevelDB absent, hostname branch absent on remote | `internalBootstrap` → `internalInitCheckpointRepoForFallback` + normal `synchronizeNoLock`; fresh LevelDB created and pushed; open/validate/migrate ✓ |
| V5 | Live DB present, format mismatch | `makeRootDatabase` throws `FormatMismatchError`; fatal crash before graph exposure ✓ |
| V6 | Live DB present, invalid replica pointer | `makeRootDatabase` throws `InvalidReplicaError`; fatal crash ✓ |
| V7 | LevelDB absent, reset/sync fails unexpectedly | Error propagates from `internalBootstrap`; fatal crash ✓ |
| V8 | Migration fails before cutover | `runMigrationUnsafe` throws; old replica remains active; fatal crash ✓ |
| V9 | Migration fails after cutover, before follow-up | New replica active on restart; no re-migration needed ✓ |
| V10 | Repeated restarts at crash cut-points | Each cut-point is restart-safe (see §5 above) ✓ |
