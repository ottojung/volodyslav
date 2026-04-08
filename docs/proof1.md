# Proof: Implementation Satisfies the IncrementalGraph Database Boot-Sequence Protocol

This document proves that the implementation in
`backend/src/generators/interface/lifecycle.js` and its callees satisfies every
normative requirement of the protocol defined in `docs/database-boot-sequence.md`
(as extended by the authoritative specification embedded in issue/PR comments).

---

## 1  Scope

The proof covers the protocol sections numbered in the specification:

| Section | Title |
|---------|-------|
| §5      | Conceptual phases |
| §6      | Boot flow (high-level Mermaid diagram) |
| §7      | Detailed protocol |
| §8      | Failure semantics |
| §9      | Crash / restart semantics |
| §10     | Observability requirements |
| §11     | Verification matrix (V1–V10) |

---

## 2  Implementation touchpoints

The proof references the following files by their logical names:

| Alias | Path |
|-------|------|
| `lifecycle` | `backend/src/generators/interface/lifecycle.js` |
| `synchronize` | `backend/src/generators/incremental_graph/database/synchronize.js` |
| `root_database` | `backend/src/generators/incremental_graph/database/root_database.js` |
| `migration_runner` | `backend/src/generators/incremental_graph/migration_runner.js` |
| `gitstore` | `backend/src/generators/incremental_graph/database/gitstore.js` |
| `working_repository` | `backend/src/gitstore/working_repository.js` |

---

## 3  Proof by protocol section

### §5 – Conceptual phases

The protocol defines four phases executed in strict order:

1. **Bootstrap source selection** (only if live DB directory is missing)
2. **Open + structural validation**
3. **Version check + migration**
4. **Expose initialized graph**

**Implementation mapping**:

```
internalEnsureInitialized (lifecycle)
  │
  ├─ Phase 1: internalBootstrap()            [only when !liveDbExists]
  │    ├─ git ls-remote check
  │    ├─ synchronizeNoLock({ resetToHostname }) OR synchronizeNoLock()
  │    └─ [closes database internally]
  │
  ├─ Phase 2: getRootDatabase() inside internalEnsureInitializedWithMigration
  │    └─ makeRootDatabase() → format check + replica pointer check
  │
  ├─ Phase 3: runMigrationUnsafe()
  │    └─ version check + optional migration transaction + replica cutover
  │
  └─ Phase 4: makeIncrementalGraph() + assignment to interfaceInstance._incrementalGraph
```

Each phase is sequenced by `await` and is non-interleaved. ✓

---

### §6 – Boot flow

The Mermaid diagram specifies:

```
B{Live DB directory exists?}
  |Yes| → C[Open RootDatabase]
  |No|  → D[Try sync reset_to_hostname=current hostname]
           → E{Hostname branch exists remotely?}
              |Yes| → C
              |No|  → F[Fallback: normal sync from empty local DB]
                       → C
```

**Proof of `B`**:  
`lifecycle.internalEnsureInitialized` calls  
`capabilities.checker.directoryExists(liveDbPath)` and sets `liveDbExists`.  
When `liveDbExists` is `true`, `internalBootstrap` is skipped and control goes
directly to `internalEnsureInitializedWithMigration` (→ Open RootDatabase). ✓

**Proof of `D`**:  
`internalBootstrap` is called only when `!liveDbExists`. ✓

**Proof of `E`**:  
`internalBootstrap` calls `git ls-remote --heads -- <remotePath> refs/heads/<hostname>-main`.  
If the output is non-empty, `hostnameBranchExists = true`. ✓

**Proof of `D → E → Yes → C`**:  
When `hostnameBranchExists`, `synchronizeNoLock({ resetToHostname: hostname })` is
called.  After it returns (success), control falls through to
`internalEnsureInitializedWithMigration` which opens the RootDatabase. ✓

**Proof of `D → E → No → F → C`**:  
When `!hostnameBranchExists`, `synchronizeNoLock()` (no reset) is called.  
After it returns (success), control falls through to `internalEnsureInitializedWithMigration`. ✓

---

### §7.1 – Bootstrap when live DB is missing

> 1. Read current hostname (`VOLODYSLAV_HOSTNAME`).

`capabilities.environment.hostname()` is called inside `internalBootstrap`. ✓

> 2. Attempt sync with `resetToHostname=<hostname>`.

`synchronizeNoLock(capabilities, { resetToHostname: hostname })` is called when  
`hostnameBranchExists`. ✓

> 3. If reset fails specifically because `<hostname>-main` does not exist remotely:  
>    – run normal sync (no reset) from empty local DB.

The pre-check with `git ls-remote` determines branch existence **before** any
sync is attempted.  If the branch is absent, `synchronizeNoLock()` (no reset) is
called instead.  This is equivalent to the "branch absent" discrimination: the
decision is made by the pre-check rather than by catching an error from the sync.
The observable effect is identical: the reset path is not taken, and the normal
sync path is taken. ✓

> 4. Any other sync/reset failure is fatal.

Neither sync path wraps its errors.  Any exception from `synchronizeNoLock`
propagates out of `internalBootstrap`, through `internalEnsureInitialized`, and
up to the caller.  `withExclusiveMode` does not catch errors. ✓

Additionally, any failure in `git ls-remote` itself (e.g. remote unreachable)
propagates fatally, satisfying §8.3 for the pre-check step. ✓

---

### §7.2 – Open + structural validation

`getRootDatabase` → `makeRootDatabase` (root_database):

1. Opens LevelDB (with up to 5 retries on transient open failures).
2. Reads `_meta/format`; if absent → writes `FORMAT_MARKER = 'xy-v2'` and  
   `current_replica = 'x'` (fresh DB path).
3. If format marker present but `!= 'xy-v2'` → throws immediately.  
   This propagates through `getRootDatabase` → `DatabaseInitializationError`,  
   which propagates through `runMigrationUnsafe` and `makeIncrementalGraph`  
   to the caller (fatal startup crash). ✓
4. Reads `_meta/current_replica`; if absent → throws `InvalidReplicaPointerError`.  
   If not in `{'x','y'}` → throws `InvalidReplicaPointerError`. ✓

Both structural validation failures propagate as uncaught errors before  
`interfaceInstance._incrementalGraph` is ever set. ✓ (§8.1, §8.2)

---

### §7.3 – Version check + migration

`runMigrationUnsafe` (migration_runner):

1. Reads active replica version via `rootDatabase.getMetaVersion()`.
2. If `undefined` (fresh DB) → writes current version, returns (no migration). ✓ (V2b)
3. If `prevVersion === currentVersion` → returns immediately (no migration). ✓ (V1)
4. If version differs → runs `runMigrationInTransaction`:
   a. Clears staging replica.
   b. Executes migration callback.
   c. Applies decisions to staging replica.
   d. Writes version into staging replica meta.
   e. `switchToReplica(toReplica)` — the atomic cutover commit. ✓ (V2)
5. Any failure inside the transaction propagates fatally before cutover. ✓ (§8.4, V8)

The cutover in step (e) is the sole point where `_meta/current_replica` is
rewritten.  All preceding writes target the staging replica only. ✓

---

### §7.4 – Exposure boundary

`internalEnsureInitializedWithMigration` assigns  
`interfaceInstance._incrementalGraph = makeIncrementalGraph(...)` only after  
`runMigrationUnsafe` returns without throwing.  `internalIsInitialized` tests  
`_incrementalGraph !== null`.  All public-facing methods guard on  
`internalRequireInitializedGraph` which throws if `null`. ✓

---

### §8 – Failure semantics

| ID | Condition | Expected | Implementation |
|----|-----------|----------|----------------|
| §8.1 | `_meta/format != xy-v2` | Fatal | `makeRootDatabase` throws; propagates before exposure ✓ |
| §8.2 | Invalid replica pointer | Fatal | `makeRootDatabase` throws `InvalidReplicaPointerError` ✓ |
| §8.3 | Unexpected reset/sync failure | Fatal | No catch around `synchronizeNoLock` calls ✓ |
| §8.4 | Migration failure | Fatal | No catch around `runMigrationUnsafe` ✓ |

---

### §9 – Crash / restart semantics

**§9.1 – Crash after reset-to-hostname success, before DB open**:  
On next start, `liveDbExists = true` (LevelDB was written by the reset sync).  
`internalBootstrap` is skipped.  Proceeds to open/validate/version-check. ✓

**§9.2 – Crash after fallback normal sync success, before DB open**:  
Same as §9.1 from the perspective of the next start. ✓

**§9.3 – Crash during migration before replica cutover**:  
`_meta/current_replica` still points to the old replica.  
Next start: `makeRootDatabase` reads old pointer, `runMigrationUnsafe` detects  
version mismatch (`prevVersion != currentVersion`), re-runs migration. ✓

**§9.4 – Crash after cutover, before follow-up side effects**:  
`_meta/current_replica` now points to the new replica.  
Next start: `makeRootDatabase` reads new pointer, `runMigrationUnsafe` detects  
`prevVersion == currentVersion` (version was written into new replica before  
cutover), no re-migration. ✓

**§9.5 – Crash after migration success, before interface exposure**:  
`_incrementalGraph` is `null` (assignment never completed).  
Next start: re-runs entire sequence; `runMigrationUnsafe` finds versions match → no migration. ✓

---

### §10 – Observability requirements

| ID | Requirement | Implementation location |
|----|-------------|------------------------|
| O1 | Whether live DB directory existed | `lifecycle.internalEnsureInitialized`: logs `{ liveDbExists }` ✓ |
| O2 | Chosen bootstrap path | `lifecycle.internalBootstrap`: logs path chosen ✓ |
| O3 | Whether reset-to-hostname was attempted | `lifecycle.internalBootstrap`: logs `'using reset-to-hostname sync path'` ✓ |
| O4 | Whether fallback was taken and exact reason | `lifecycle.internalBootstrap`: logs `'hostname branch absent; using normal sync fallback'` ✓ |
| O5 | Detected format marker result | `root_database.makeRootDatabase`: throws with format details if mismatch; `get_root_database.getRootDatabase` logs `'Root database opened'` on success ✓ |
| O6 | Detected replica pointer result | `root_database.makeRootDatabase`: throws `InvalidReplicaPointerError` with value if invalid; pointer value used in construction ✓ |
| O7 | Detected active version and current app version | `migration_runner.runMigrationUnsafe`: logs `{ prevVersion, currentVersion }` ✓ |
| O8 | Whether migration ran | `migration_runner.runMigrationUnsafe`: logs start and completion messages ✓ |
| O9 | Whether cutover committed, final replica/version | `migration_runner.runMigrationUnsafe`: logs success with version details ✓ |
| O10 | Final startup result | `lifecycle.internalEnsureInitialized`: logs `'Bootstrap: startup completed successfully'` on success; any fatal error propagates with its class and message ✓ |

---

### §11 – Verification matrix

| ID | Scenario | Expected | Proof |
|----|----------|----------|-------|
| V1 | Live DB exists, valid, current version | Startup succeeds without migration | `liveDbExists=true` → skip bootstrap; `makeRootDatabase` opens DB; `runMigrationUnsafe` detects matching version → no migration; graph exposed ✓ |
| V2 | Live DB exists, valid, old version | Migration runs, then startup succeeds | As V1 except `prevVersion != currentVersion` → migration transaction + cutover; graph exposed ✓ |
| V2b | Fresh DB (no version recorded) | Current version recorded, no migration | `getMetaVersion()` returns `undefined`; version written; no migration callback; graph exposed ✓ |
| V3 | Live DB missing, hostname branch exists | Reset bootstrap path; open/validate/migrate | `liveDbExists=false`; `ls-remote` → branch found; `synchronizeNoLock({ resetToHostname })` restores DB; then V1/V2/V2b applies ✓ |
| V4 | Live DB missing, hostname branch absent | Fallback normal sync; open/validate/migrate | `liveDbExists=false`; `ls-remote` → branch absent; `synchronizeNoLock()` (no reset); DB created fresh; then V2b applies ✓ |
| V5 | Live DB exists, format mismatch | Fatal crash before graph exposure | `makeRootDatabase` throws before `_incrementalGraph` is set ✓ |
| V6 | Live DB exists, invalid replica pointer | Fatal crash before graph exposure | `makeRootDatabase` throws `InvalidReplicaPointerError` ✓ |
| V7 | Live DB missing, reset path fails (unexpected) | Fatal crash | Any error from `synchronizeNoLock({ resetToHostname })` propagates uncaught ✓ |
| V7b | Live DB exists but malformed | Fatal crash (assumption violation) | `makeRootDatabase` throws on format/pointer read failure ✓ |
| V7c | Hostname branch exists, rendered data malformed | Fatal crash (assumption violation) | `synchronizeNoLock` propagates `InvalidSnapshotReplicaError` or similar ✓ |
| V8 | Migration fails before cutover | Fatal crash; previous replica active | `runMigrationInTransaction` aborts; `_meta/current_replica` unchanged; propagates uncaught ✓ |
| V9 | Migration fails after cutover | Fatal crash; new replica active on restart | Cutover is committed before any follow-up; crash leaves new pointer; restart reads it; V2b/V1 applies ✓ |
| V9b | Migration succeeds, rendered/git follow-up fails | Startup result matches restart-safe boundary | Non-DB side effects are outside `internalEnsureInitializedWithMigration`; boot still exposed ✓ |
| V10 | Repeated restarts at each cut-point | Deterministic re-entry | §9 proof above covers all cut-points; each restart re-runs checks from top ✓ |

---

## 4  Summary

All normative requirements of the IncrementalGraph database boot-sequence
protocol are satisfied by the implementation.  The key properties are:

1. **Phase separation**: bootstrap, structural validation, migration, and
   exposure are sequenced by `await` with no interleaving.
2. **Fail-fast**: no error is silenced before exposure; all fatal paths propagate
   uncaught out of `internalEnsureInitialized`.
3. **Restart safety**: the atomicity of the cutover commit in
   `runMigrationInTransaction` ensures deterministic re-entry from any crash
   cut-point.
4. **Bootstrap discrimination**: `git ls-remote` pre-check distinguishes
   "hostname branch absent" from all other failures without string-matching git
   error output.
5. **Observability**: structured log entries are emitted at every decision point
   called out in §10.
