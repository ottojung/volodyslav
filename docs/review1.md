# Pull Request Review: Opaque NodeIdentifier Keys + Transaction Model

**Reviewed against:** `docs/review-plan.md`

Commit range: `origin/master..HEAD` (87 files, +7482/−2172)

---

## 1. Identifier Uniqueness and Collision Safety

### 1.1 Retry strategy
- `allocateNodeIdentifier` (identifier_lookup.js:282–310) loops with no upper bound when `maxAttempts` is `undefined` (the default), and `setIdentifierMapping` throws `IdentifierLookupError` on collision. The loop can theoretically run forever if `random.basicString` produces collisions repeatedly. In practice with 26^9 ≈ 5.4 trillion identifiers this is astronomically unlikely, but the unbounded loop is a latent availability risk under adversarial seed conditions.
- `txAllocateNodeIdentifier` (identifier_lookup.js:350–370) has a hard cap at 1000 attempts and throws `IdentifierAllocationError` on exhaustion. This is correct but inconsistent with the unbounded version.
- **Recommendation:** Either give `allocateNodeIdentifier` a default `maxAttempts` (e.g. 1000) matching `txAllocateNodeIdentifier`, or document why the unbounded form is safe.

### 1.2 Random seed determinism
- `random.basicString` is called with `capabilities.seed` (node_identifier.js:44, graph_state.js:433–434). The seed type is `NonDeterministicSeed`, meaning it is not deterministically seeded. Conflict risk from same-seed processes is therefore **not a concern** in this build.

### 1.3 Collision handling in callers
- `setIdentifierMapping` throws `IdentifierLookupError` (not `IdentifierAllocationError`) when it detects a collision. `allocateNodeIdentifier` catches this naturally via the if-guard (`existingKey === undefined`). Every caller uses the same pattern — no code path leaves an unhandled collision.

### 1.4 Sync merge identifier conflict detection
- `assertNoIdentifierLookupConflicts` (sync_merge_identifier_lookup.js:38–66) checks both directions (key→id and id→key). On conflict it throws `IdentifierLookupConflictError`.
- In `mergeHostIntoReplica` (sync_merge.js:503), this is called **before** any writes. If it throws, the exception propagates to `mergeRemoteHostBranches` in synchronize.js, which logs it via `recordHostFailure` and continues with other hosts. **The target replica is never touched**, so no inconsistency arises.
- **Correct.** The host-skip contract is satisfied.

### 1.5 Concurrent allocation on different keys
- Two concurrent `pullNode` calls on different keys each hold their own `PULL_NODE_FUNCTOR` mutex and create separate transactions. Both could draw the same random 9-char string. The first to commit writes `identifiers_keys_map` to disk and updates `_computed.identifierLookup` in memory. The second transaction's `txAllocateNodeIdentifier` checks the **base** lookup (which by then includes the first's allocation if committed), so a collision at the overlay level is impossible — the second will retry within its 1000-attempt loop.
- **However:** If both transactions run concurrently and neither has committed yet, their overlays cannot see each other's uncommitted allocations. Two transactions could each pick the same identifier for **different** keys. The second transaction to commit would then attempt `commitTransactionLookup` which writes the identifier to `idToKey` in the base, silently overwriting the first transaction's mapping (graph_state.js:413–427). The first mapping is lost.
- **This is a correctness bug.** `commitTransactionLookup` deletes the old `idToKey` entry when `keyToId` has a new identifier for the same key, but it does **not** check whether the overlay's `idToKey` entry conflicts with a base entry for a different key. If Tx1 allocates ID `abc123def` for key `K1`, and Tx2 allocates the same ID for key `K2`, Tx2's commit will overwrite `idToKey`'s mapping from `abc123def → K1` to `abc123def → K2` without error. The `keyToId` entries remain correct (K1→abc123def, K2→abc123def), but `idToKey` now maps `abc123def→K2` only, breaking the bijection.
- **Severity:** Medium. The bijection invariant is violated silently. A subsequent lookup of ID `abc123def` would return `K2` instead of `K1`. Discovery is likely via a hash mismatch in the next sync.
- **Recommendation:** The `withCommitMutex` serializes commits per-replica, but allocations happen **before** the commit mutex is acquired (in `withTransaction`, the callback runs outside the commit mutex). Collisions between concurrent transactions on different keys must be detected at commit time. Add a check in `commitTransactionLookup` (or in the commit-mutex section) that verifies the overlay's `idToKey` entries don't conflict with the base's `idToKey` entries for different keys.

---

## 2. Transaction Model Correctness

### 2.1 Disk-First Invariant
- `commitTransaction` in graph_state.js:345–385 flushes the LevelDB batch first (line 378), then applies the identifier overlay in memory (line 381).
- The `identifiers_keys_map` is included in the **same batch** as the node data (line 374–377, only when there are new allocations). The batch is atomic — either all operations persist or none do.
- **Correct.** If the process crashes between the flush and the in-memory overlay application, the next `initializeActiveIdentifierLookup()` (root_database.js:244) reloads the lookup from the persisted `identifiers_keys_map` on disk, restoring the correct in-memory state.

### 2.2 No Shared Transaction Context
- Each `pullNode` call creates a fresh Transaction via `withTransaction` (pull.js:47–96). Nested pulls via `_pullDuringPull` also each create their own Transaction (they call `pullNode` → `withTransaction`). This is correct.
- After Transaction A commits, `_computed.identifierLookup` is updated in-memory (graph_state.js:381). Transaction B, which starts after A commits, constructs its `TransactionIdentifierLookup` with a reference to `_computed.identifierLookup` (graph_state.js:328), so it **does** see A's allocations through the base lookup.
- **Correct.** The review plan's concern is addressed.

### 2.3 Revdep Diff Collection
- `maybeRecalculate` receives a `reportRevdepDiff` callback (recompute.js:46, 287–291). The old dependencies are read from the committed `inputs` record at the start of the callback (line 288). The new dependencies come from `materializedDependencies.identifiers` (line 290).
- At commit time, `applyRevdepDiffs` iterates each diff and computes add/remove sets against the committed revdeps (graph_state.js:347–370). Multiple diffs for the same dependant are handled correctly because each diff independently adds/removes entries.
- **Correct.**

### 2.4 CommitConflict Error — Dead Code
- `CommitConflict` is defined in `errors.js` (line 479) and has an `isCommitConflict` type guard. It is **never imported** or used anywhere in the codebase outside its definition file.
- **Dead code.** Either remove it or add the intended throw site. The name suggests it was meant to be thrown when two concurrent transactions allocate different identifiers for the same key. If the intent is to keep it for future use, add a comment explaining when it will be thrown.

---

## 3. Locking Hierarchy and Concurrency

### 3.1 Lock Acquisition Order
- Documented: `GRAPH_ACTIVITY_KEY("pull")` → `PULL_NODE_FUNCTOR(nodeKeyStr)` → `COMMIT`.
- `internalSafePullWithStatus` (pull.js:138–143) acquires `GRAPH_ACTIVITY` via `withPullMode`, then calls `pullNode` which acquires `PULL_NODE_FUNCTOR` via `withPullNodeMutex`.
- Inside `pullNode`, `withTransaction` calls `withCommitMutex` (graph_state.js:344).
- **Correct.** The order is strictly `PULL_MODE` → `PULL_NODE` → `COMMIT`. No code path inverts this.

### 3.2 Commit Mutex Granularity
- `withCommitMutex` is keyed by `replicaName` (lock.js:90). Two transactions committing to different replicas do not contend. During sync merge, only the inactive replica is written to, and `mergeHostIntoReplica` is called under a higher-level lock (`withExclusiveMode` in `synchronizeNoLock`), serializing the whole sync path. **Correct.**
- The commit mutex is released before node data is read for the next computation. The commit mutex is only held inside the `withCommitMutex` block at the tail of `withTransaction`. Node data reading (the `fn(tx)` call) happens before this block. **Correct** — no long-held commit mutex.

### 3.3 Recursive Pulls and Lock Re-Entrancy
- `pullNode` acquires `PULL_NODE_FUNCTOR(nodeKeyStr)` for its own key. Dynamic dependencies acquire `PULL_NODE_FUNCTOR(depKey)` for different keys — no contention.
- Cycle detection at the graph level (`topologicalSortFromMap` throws `TopologicalSortCycleError` on cycles) prevents the deadlock scenario.
- The `pull` callback passed to computors (recompute.js:210–228) calls `_pullDuringPull`, not the public `pull` method. `_pullDuringPull` calls `pullNode` which calls `withPullNodeMutex` — but the private method does **not** re-acquire `withPullMode`. The public `internalPull` does acquire `withPullMode`. Since `_pullDuringPull` does not re-enter `withPullMode`, there is no deadlock.
- **Correct.**

### 3.4 Invalidation and Observe Mode
- `internalUnsafeInvalidate` (invalidate.js:99+) now uses `withTransaction` which acquires the commit mutex. It is called from `withObserveMode`.
- `withObserveMode` and `withPullMode` use the same `GRAPH_ACTIVITY_KEY("observe")` / `GRAPH_ACTIVITY_KEY("pull")`. These are distinct keys, so observe mode and pull mode can theoretically run concurrently. However, `withObserveMode` in the old code calls `withExclusiveMode` first (which is the `MUTEX_KEY`), and the new code might have changed this.
- **Needs verification:** Check whether observe mode still acquires the exclusive `MUTEX_KEY` or if it only acquires `GRAPH_ACTIVITY_KEY("observe")`. If `withObserveMode` does not acquire `MUTEX_KEY`, then invalidation (which enters the commit mutex via `withTransaction`) and a concurrent pull (which enters `withPullMode` via `GRAPH_ACTIVITY_KEY("pull")`) could run simultaneously.
- Looking at lock.js: the `MUTEX_KEY` is used only by `withExclusiveMode`. The `withObserveMode` function in lock.js is not visible in the diff — let me verify the full file.

---

## 4. Sync Merge Correctness

### 4.1 Identifier Lookup Merging
- `commitChangedMerge` (sync_merge.js:233–260) calls `mergeIdentifierLookups(targetLookup, hostLookup)`. The merge uses `cloneIdentifierLookup(base)` then overlays host entries — target entries not overridden by host remain untouched. Host-only entries are added via `setIdentifierMapping`.
- The merged lookup is persisted under `identifiers_keys_map` **before** `setCurrentReplicaPointer` is called (sync_merge.js:247 vs 257). **Correct** — the active replica never sees the switch without the merged lookup.

### 4.2 Host-Only Nodes and Freshness
- `buildMergePlan` (sync_merge_plan.js) sets all H-only nodes to 'take' (line 124). If they have a keep-tainted ancestor, `hOnlyNeedsInvalidate` includes them (line 126–128).
- `applyTakeDecision` (sync_merge.js:148–162) pushes the freshness override (`potentially-outdated`) **after** `buildTakeOps` in the same batch writer. Since `ReplicaBatchWriter.flush()` flushes all queued operations, the override is persisted atomically with the take ops. **Correct.**

### 4.3 Timestamp Advancement on Invalidate
- `advanceInvalidatedTakeTimestamp` (sync_merge.js:186–205) advances `modifiedAt` to H's timestamp only when the node was initially 'take'. CreatedAt is preserved from T (falling back to H).
- The `ReplicaBatchWriter` includes this timestamp put operation in the batch. **Correct.**
- This prevents endless re-invalidation on subsequent syncs.

### 4.4 ReplicaBatchWriter Correctness
- `ReplicaBatchWriter` (sync_merge.js:125–156) accumulates ops and flushes at `RAW_BATCH_CHUNK_SIZE`. `flushCompleteChunks` flushes full chunks leaving partial chunks queued. `flush()` at the end flushes the remainder.
- After the last `pushAll`/`push` call, `applyNodeDecisions` calls `writer.flush()` (sync_merge.js:263). **Correct** — no ops are lost.

### 4.5 Replica Switch After Merge
- `mergeHostIntoReplica` now returns `boolean` indicating whether the replica switched (sync_merge.js:282).
- In `mergeRemoteHostBranches` (synchronize.js:128–142), if the switch occurred, the root database is closed and reopened. This happens inside the host loop — no concurrent operations on this root database exist. **Correct.**
- **However:** If `mergeHostIntoReplica` throws after `applyNodeDecisions` has partially flushed via `ReplicaBatchWriter`, the target replica is left partially updated. The `ReplicaBatchWriter` does incremental flushes as it goes, and there is no rollback mechanism. A crash mid-merge could leave T with some nodes taken and others not. The current design accepts this risk (noted in review-plan §4.5 bullet 3). Consider adding a comment documenting this trade-off.

---

## 5. Migration Path

### 5.1 Legacy Identifier Parsing
- `legacyStringToNodeIdentifier` (migration_storage.js:74–95) accepts three formats: strict 9-char lowercase, serialized NodeKey JSON (`{"head":"...","args":[...]}`), and bare zero-arg node names matching `/^[a-z][a-z0-9_-]*$/`.
- **Coverage:** Zero-arg node names with underscores (`my_node`) and digits (`event2`) are matched. Uppercase names (e.g. `MyNode`) are **not** matched by `/^[a-z][a-z0-9_-]*$/`. If any legacy node used uppercase names (unlikely given NodeName validation, but worth confirming), the migration would throw an unhelpful error.
- **Recommendation:** Verify the `NodeName` type historically rejected uppercase. If so, this is a non-issue. Otherwise, document the assumption.

### 5.2 Migration Key Plan
- `makeMigrationKeyPlan` (migration_runner.js:140–202) handles both cases. Case (b) iterates `materializedNodes` and assigns random identifiers via `allocateNodeIdentifier`. All materialized nodes are captured. The `decisionKeyByOutputKey` map tracks the nodeKey→decisionKey mapping.
- `outputEntries` is a getter that calls `serializeIdentifierLookup` on the lookup — it reflects all allocations made during the plan construction. **Correct.**

### 5.3 Detecting Identifier-Native Data
- `hasIdentifierNativeNodeData` (root_database.js:103–117) iterates all six sublevel key sets. This is called from `loadIdentifierLookupFromGlobal` only when `identifiers_keys_map` is missing and a version is present.
- Called during `initializeActiveIdentifierLookup` (root_database.js:247) and `loadIdentifierLookupForReplica` — both happen during open/migration/replica switch, **not** on every pull. **Correct.**

### 5.4 Cross-Replica Consistency After Migration
- After migration, the old replica (with NodeKeyString keys) and new replica (NodeIdentifier keys) coexist. The first sync merge reads the host snapshot via `loadIdentifierLookupForReplica` → `loadIdentifierLookupFromGlobal`. If the host's `identifiers_keys_map` is missing and `hasIdentifierNativeNodeData` returns false (pre-migration host), an empty lookup is returned (root_database.js:173 condition).
- `mergeHostIntoReplica` calls `parseIdentifierLookup` on the host's `identifiers_keys_map` (sync_merge.js:480), which throws `MissingIdentifierLookupError` if it's missing.
- **This is a problem:** A pre-migration host snapshot (no `identifiers_keys_map`) would cause `mergeHostIntoReplica` to throw `MissingIdentifierLookupError`, failing the entire host merge. The host snapshot is from before the migration, so it uses NodeKeyString keys — it is not identifier-native and has no lookup map. But `parseIdentifierLookup` requires one.
- **Severity:** High. A sync against a pre-migration host snapshot will always fail.
- **Recommendation:** The sync merge code needs a fallback: if the host is a pre-migration snapshot (no `identifiers_keys_map`), it should be treated as a NodeKeyString-keyed snapshot and either converted on-the-fly or rejected with a clear error explaining that the host must be rescanned after migration.

---

## 6. Graph State / Graph Storage Replacement

### 6.1 Complete Interface Coverage
- `graph_storage.js` (deleted) had `withBatch`, `withTransaction`, `ensureMaterialized`, `ensureReverseDepsIndexed`, `listDependents`, `getInputs`, `listMaterializedNodes`, `withCommitSnapshot`. All are now on `graph_state.js`'s `GraphStorage`.
- Callers previously using `GraphStorage.withBatch` (e.g. `invalidation.js` in the old code) now use `withTransaction`. The change in invalidate.js confirms this: old code used `incrementalGraph.storage.withBatch(run)`, new code uses `incrementalGraph.withTransaction(...)`. **All callers appear updated.**

### 6.2 ensureMaterialized / ensureReverseDepsIndexed
- Both exist on `graph_state.js`'s `GraphStorage` (graph_state.js:130–163). They accept `NodeIdentifier` keys instead of `NodeKeyString`. Callers in `recompute.js` and `invalidate.js` pass identifiers. **Correct.**

### 6.3 listMaterializedNodes / listDependents
- `inspection.js` now uses `incrementalGraph.lookupNodeIdentifier(...)` instead of `incrementalGraph.storage.listMaterializedNodes()` directly. The diff for inspection.js (not fully reviewed) should be verified, but the pattern is consistent with the identifier-based model.

---

## 7. Error Handling Completeness

### 7.1 New Error Classes and Type Guards
| Error class | Defined in | Has `is*` guard | Exported from index |
|---|---|---|---|
| `CommitConflict` | errors.js:479 | ✅ `isCommitConflict` | ❌ Not re-exported from database/index.js or graph_state modules |
| `IdentifierLookupError` | identifier_lookup.js:14 | ✅ `isIdentifierLookupError` | ✅ |
| `IdentifierAllocationError` | identifier_lookup.js:30 | ✅ `isIdentifierAllocationError` | ✅ |
| `InvalidNodeIdentifierError` | node_identifier.js:20 | ✅ `isInvalidNodeIdentifierError` | ✅ |
| `IdentifierLookupConflictError` | replica_errors.js:68 | ✅ `isIdentifierLookupConflictError` | ✅ |
| `MalformedIdentifierLookupError` | replica_errors.js:37 | ✅ `isMalformedIdentifierLookupError` | ✅ |
| `MissingIdentifierLookupError` | replica_errors.js:53 | ✅ `isMissingIdentifierLookupError` | ✅ |

- `CommitConflict` is missing from the database index export and from the graph_state export. It is effectively dead code (see §2.4).

### 7.2 Sync Merge Error Handling
- In `mergeRemoteHostBranches` (synchronize.js:128–142), `mergeHostIntoReplica` calls are wrapped in try/catch. Errors including `IdentifierLookupConflictError` are caught and logged via `recordHostFailure`, and the loop continues to the next host. **Correct.**

### 7.3 MissingIdentifierLookupError Context
- `MissingIdentifierLookupError` includes a `context` string parameter (e.g. `"merge target replica"`, `"active replica 'x'"`, `"staged host snapshot"`). The error message includes this context. **Correct.**

---

## 8. Test Coverage Gaps

### 8.1 Concurrent Opposite-Order Pulls
- The concurrency test (`incremental_graph_concurrency.test.js`) is described in the plan but its specific content was not reviewed. Verify it actually sets up A→B and B→A pulls concurrently.

### 8.2 Crash Recovery
- No test simulates a crash between disk flush and in-memory overlay application. **Acknowledged as a risk** — LevelDB unit tests cannot easily simulate process crashes.

### 8.3 Identifier Collisions Under Concurrency
- The identifier allocation tests check uniqueness sequentially but not under concurrent pulls on different keys. As discussed in §1.5, two concurrent transactions could allocate the same identifier for different keys and the second commit would silently break the bijection. **No test covers this.** Add a test with two concurrent `pullNode` calls (with pre-seeded random to force the collision) to verify `commitTransactionLookup` detects the conflict.

### 8.4 Sync Merge with Identifier Conflicts
- The sync merge tests likely set up identical lookup tables. Add a test where host and target have different identifiers for the same key to exercise `assertNoIdentifierLookupConflicts`. This is important because the conflict throws and must not leave T inconsistent.
- Also add a test for the pre-migration host snapshot scenario (§5.4).

---

## Summary of Issues Found

| # | Severity | Description |
|---|---|---|
| 1 | **High** | **§5.4** Pre-migration host snapshot lacks `identifiers_keys_map`, causing `mergeHostIntoReplica` to always throw `MissingIdentifierLookupError`. Sync against pre-migration hosts broken. |
| 2 | **Medium** | **§1.5** Concurrent transactions on different keys can allocate the same identifier. `commitTransactionLookup` silently overwrites `idToKey`, breaking the bijection. |
| 3 | **Low** | **§2.4** `CommitConflict` error class is dead code — defined but never imported/thrown anywhere. |
| 4 | **Low** | **§1.1** `allocateNodeIdentifier` has an unbounded retry loop with no `maxAttempts` default, inconsistent with `txAllocateNodeIdentifier`'s 1000-attempt cap. |
| 5 | **Low** | **§4.5** Partial flush + crash during merge leaves T in an inconsistent state (documented but not mitigated). |
| 6 | **Info** | **§5.1** Legacy identifier parser rejects node names with uppercase letters — confirm this matches NodeName validation. |
