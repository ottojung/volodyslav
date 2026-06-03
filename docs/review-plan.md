# Review Plan

This PR is a large cross-cutting change that introduces **opaque NodeIdentifier keys** (9-char lowercase ASCII strings) to replace semantic NodeKeyString keys in every sublevel of the incremental graph database. Alongside that, it:

- Replaces `graph_storage.js` with a **Transaction model** (`graph_state.js`) for volatile-persistent consistency.
- **Rewrites `sync_merge.js`** completely, splitting it into several focused modules.
- Refines the **locking hierarchy** with a new commit mutex.
- Overhauls the **migration runner** to translate legacy NodeKeyString keys to NodeIdentifier keys.
- Adds a **volatile consistency specification** and 1191-line conformance test.

---

## 1. Identifier Uniqueness and Collision Safety

**Files:** `identifier_lookup.js`, `node_identifier.js`, `graph_state.js`, `class.js`

- `allocateNodeIdentifier` / `txAllocateNodeIdentifier` use random 9-char strings. What is the collision probability and retry strategy? Does the while loop in `allocateNodeIdentifier` always terminate?
- Is the random generator (`random.basicString`) seeded deterministically? If so, two processes that start with the same seed will collide on identifier allocation.
- `setIdentifierMapping` checks `keyToId.has(key)` and `idToKey.has(id)` before setting. If a collision is detected, `IdentifierAllocationError` is thrown. Verify that every caller catches this and retries. If not, a transient collision kills the operation.
- During sync merge, `mergeIdentifierLookups` combines target and host lookups. What if both sides independently allocated different identifiers for the **same** semantic key? The conflict detection in `assertNoIdentifierLookupConflicts` throws — verify that this is handled at the sync level (fails the host merge) and does not leave T in an inconsistent state.

---

## 2. Transaction Model Correctness

**Files:** `graph_state.js`, `pull.js`, `recompute.js`, `invalidate.js`, `class.js`

### 2.1 Disk-First Invariant
- `commitTransaction` in `graph_state.js` flushes the LevelDB batch first, then applies the identifier lookup overlay in memory. If the flush succeeds and the process crashes before the in-memory overlay is applied, the next open will reload from disk (which has the batch) and rebuild the lookup from the persisted `identifiers_keys_map`. Verify that `identifiers_keys_map` is written atomically with the batch that contains the node data — otherwise the lookup will reference identifiers whose node data was lost, or node data will exist without a lookup entry.

### 2.2 No Shared Transaction Context
- Each `pullNode` creates its **own** Transaction via `withTransaction`. Nested pulls (dynamic dependencies) also each create their own Transaction. Verify that there is no correctness gap where two back-to-back Transactions from the same top-level pull chain could observe inconsistent state (e.g., the first Transaction allocates an identifier, the second Transaction's `identifierLookup` overlay does not see it because it reads from `_computed.identifierLookup` which hasn't been updated yet).
- How does `lookupNodeIdentifier(tx, inputKey)` work across two different Transactions in the same pull chain? Verify it reads from the current transaction's overlay first, then falls back to the committed lookup. If Transaction A allocates an identifier and commits, Transaction B (started after A commits) should see it via the committed lookup. Confirm this is the path.

### 2.3 Revdep Diff Collection
- `maybeRecalculate` receives a `reportRevdepDiff` callback and pushes diffs during computation. At commit time, `applyRevdepDiffs` is called inside `commitTransaction`. Verify that:
  - The old dependencies recorded in the RevdepDiff are accurate (read from the committed revdeps state before the transaction modifies it).
  - The new dependencies are calculated from post-computation input identifiers.
  - Multiple revdep diffs for the same dependant are merged correctly (not double-counted or conflicting).

### 2.4 CommitConflict Error
- A new `CommitConflict` error class exists but it is unclear where it is thrown or caught. Search for all throw/usage sites. If it is unused, it is dead code; if it is thrown, verify the callers handle it gracefully.

---

## 3. Locking Hierarchy and Concurrency

**Files:** `lock.js`, `pull.js`, `graph_state.js`, `class.js`

### 3.1 Lock Acquisition Order
- The documented order is: `GRAPH_ACTIVITY_KEY("pull")` → `PULL_NODE_FUNCTOR(nodeKeyStr)`. Verify this matches the code.
- Inside the per-node mutex, `withTransaction` obtains the commit mutex via `withCommitMutex`. Verify the order is: `GRAPH_ACTIVITY` → `PULL_NODE` → `COMMIT`. Is there any code path that acquires locks in a different order? Deadlock would result.

### 3.2 Commit Mutex Granularity
- `withCommitMutex` is keyed by `replicaName`. Verify that two concurrent transactions committing to different replicas do not contend. During sync merge, only one replica is being written to — verify correctness.
- Is the commit mutex released before node data is read for the next computation? A long-held commit mutex would serialize all graph operations.

### 3.3 Recursive Pulls and Lock Re-Entrancy
- A `pullNode` call acquires `PULL_NODE_FUNCTOR(nodeKeyStr)` for its own key. If its computor pulls a dependency (different key), that dependency's `pullNode` acquires `PULL_NODE_FUNCTOR(depKey)`. Since these are different keys, there is no contention. However, if the graph has a cycle, deadlock results. Verify that cycle detection at the graph level prevents this.
- Verify that `withPullMode` is **not** re-entrant — it is a `withMutex` that does not support recursive acquisition. If a computor calls `graph.pull(...)` (the public entry point) instead of `_pullDuringPull(...)`, it will deadlock on `withPullMode`. Confirm that the `pull` parameter passed to computors always resolves to `_pullDuringPull` or equivalent, never to the public `pull` method.

### 3.4 Invalidation and Observe Mode
- `internalUnsafeInvalidate` runs inside `withTransaction`, which acquires the commit mutex. But it is called from `withObserveMode`. Verify that `withObserveMode` and `withPullMode` are properly exclusive (same key, different modes) — an invalidate should not run concurrently with a pull on the same graph.

---

## 4. Sync Merge Correctness

**Files:** `sync_merge.js`, `sync_merge_plan.js`, `sync_merge_transfer.js`, `sync_merge_revdeps.js`, `sync_merge_identifier_lookup.js`, `sync_merge_timestamps.js`

### 4.1 Identifier Lookup Merging
- `commitChangedMerge` calls `mergeIdentifierLookups(targetLookup, hostLookup)`. Verify the merge semantics:
  - Target entries always win if both sides have the same key → id mapping? (Conservative policy is stated.)
  - Host-only entries are appended.
  - The merged lookup is persisted under `identifiers_keys_map` **before** the replica pointer is switched. Confirm this ordering prevents the active replica from ever lacking the merged lookup.

### 4.2 Host-Only Nodes and Freshness
- Host-only nodes (`hOnlyNodes`) are always 'take'. If they have a keep-tainted ancestor, they get `potentially-outdated` freshness. Verify that the freshness override is applied **after** `buildTakeOps` in the same batch (or in `applyNodeDecisions`). If the override is lost, host-only nodes might stay `up-to-date` with stale values.

### 4.3 Timestamp Advancement on Invalidate
- When a node that was initially 'take' is invalidated, its `modifiedAt` is advanced to H's timestamp. This is necessary to avoid endless re-invalidation on the next sync. Verify:
  - This only happens when `initialDecision === 'take'` (not for 'keep' nodes tainted to invalidate).
  - The `createdAt` is preserved from T (or H as fallback).
  - The `ReplicaBatchWriter` correctly includes this timestamp put operation.

### 4.4 ReplicaBatchWriter Correctness
- `ReplicaBatchWriter` accumulates ops and flushes at `RAW_BATCH_CHUNK_SIZE`. When `flushCompleteChunks` is called, it may leave a partial chunk queued. The final `flush()` call flushes the remainder. Verify that no ops are lost between the last `pushAll`/`push` call and the `flush()` call.

### 4.5 Replica Switch After Merge
- `mergeHostIntoReplica` returns `boolean` indicating whether the replica switched. The caller in `synchronize.js` uses this to close and reopen `rootDatabase`. Verify that:
  - Between the replica switch and the reopen, no concurrent operations read the old (closed) database handles.
  - The reopen correctly picks up the new active replica's `identifiers_keys_map`.
  - If `mergeHostIntoReplica` throws after partially applying decisions, the state is consistent (currently decisions are flushed incrementally via `ReplicaBatchWriter` — a partial flush + crash could leave T partially updated).

---

## 5. Migration Path

**Files:** `migration_runner.js`, `migration_storage.js`, `root_database.js`

### 5.1 Legacy Identifier Parsing
- `legacyStringToNodeIdentifier` in `migration_storage.js` accepts three formats: strict (`/^[a-z]{9}$/`), serialized node key JSON, and bare zero-arg node names. The strict validator rejects anything that doesn't match. Verify that all legacy nodes in existing databases will be covered by one of these three formats. Are there any edge cases (e.g., node names with underscores, uppercase, leading digits)?

### 5.2 Migration Key Plan
- `makeMigrationKeyPlan` handles two cases: (a) the source already has an `identifiers_keys_map` entry, and (b) it doesn't (pre-migration database). In case (b), it iterates `materializedNodes` and assigns new random identifiers. Verify:
  - All `materializedNodes` are captured (no missing entries).
  - The `decisionKeyByOutputKey` map correctly tracks the nodeKey → decisionKey mapping for the migration callback.
  - The `outputEntries` include every node in the final state.

### 5.3 Detecting Identifier-Native Data
- `hasIdentifierNativeNodeData` iterates all sublevel keys to check if any match the `isValidNodeIdentifier` pattern. This is an O(n) scan on every `loadIdentifierLookupFromGlobal` call when the `identifiers_keys_map` is missing. Verify this is only called during migration/replica open, not on every pull.

### 5.4 Cross-Replica Consistency After Migration
- After migration, the old replica (NodeKeyString keys) and new replica (NodeIdentifier keys) both exist. The first sync merge copies L→T and the target T now has identifier-native keys. Verify the host snapshot (which was produced pre-migration) is correctly read — its global/identifiers_keys_map may be missing, triggering `MissingIdentifierLookupError`. Is this caught and handled?

---

## 6. Graph State / Graph Storage Replacement

**Files:** `graph_state.js` (new), `graph_storage.js` (deleted), `class.js`, `inspection.js`

### 6.1 Complete Interface Coverage
- `graph_storage.js` was deleted and its functionality was split between `graph_state.js` and the Transaction model. Verify that all callers previously using `GraphStorage.withBatch` now use the Transaction model correctly. Did any caller get missed?

### 6.2 ensureMaterialized / ensureReverseDepsIndexed
- These methods previously existed on `GraphStorage`. Verify they are still accessible (either on `graph_state` or through `tx.batch`). If they are removed, verify the callers use equivalent logic.

### 6.3 listMaterializedNodes / listDependents
- `inspection.js` previously used `incrementalGraph.storage.listMaterializedNodes()`. Now it uses `incrementalGraph.lookupNodeIdentifier(...)`. Verify all inspection methods (`getFreshness`, `getValue`, `listMaterializedNodes`) correctly translate semantic keys to identifiers before reading from storage.

---

## 7. Error Handling Completeness

**Files:** `errors.js`, `replica_errors.js`, `identifier_lookup.js`, `sync_merge.js`

- New error classes: `CommitConflict`, `IdentifierLookupConflictError`, `MalformedIdentifierLookupError`, `MissingIdentifierLookupError`, `IdentifierAllocationError`, `IdentifierLookupError`. Verify each has a type guard (`is*` function) and is exported from the appropriate index file.
- When `assertNoIdentifierLookupConflicts` throws `IdentifierLookupConflictError`, verify the sync merge error handling in `mergeRemoteHostBranches` records this as a host failure (not a fatal crash) and continues with other hosts.
- `MissingIdentifierLookupError` is thrown when a replica has identifier-native node data but no `identifiers_keys_map`. Verify this provides enough context for the user to recover (the error message includes which replica).

---

## 8. Test Coverage Gaps

**Files:** `incremental_graph_volatile_consistency.test.js`, `incremental_graph_concurrency.test.js`, `sync_merge.test.js`, `identifier_resolver.test.js`, `identifiers_keys_map_correctness.test.js`

### 8.1 Concurrent Opposite-Order Pulls
- The concurrency test mentions "concurrent opposite-order pulls with pre-allocated shared inputs". Verify this test actually exercises the race condition it describes (two pulls that depend on each other's inputs in opposite order, e.g., A→B and B→A, which should deadlock or be prevented).

### 8.2 Crash Recovery
- The volatile consistency tests verify isomorphism after clean commits. But there is no test that simulates a crash between disk flush and in-memory overlay application. If this is impossible to test at the unit level, note it as a risk.

### 8.3 Identifier Collisions Under Concurrency
- The identifier allocation tests check uniqueness sequentially. Under concurrent pulls (multiple `withPullNodeMutex` holders), two transactions could each allocate the same random identifier. The mutex prevents this per key, but concurrent pulls on **different** keys could collide. Verify the tests cover this scenario.

### 8.4 Sync Merge with Identifier Conflicts
- The sync merge tests likely use identical lookup tables on both sides. There should be a test where host and target have different identifiers for the same key (to exercise `assertNoIdentifierLookupConflicts`).

---
