# PR #1335 Review Thread 1 — Problem Analysis

Thread: `pullrequestreview-4323287876`

This review identifies **three correctness defects** in the current implementation after the identifier migration.

## 1) Lost `identifiers_keys_map` persistence in sync merge

### Where
`backend/src/generators/incremental_graph/database/sync_merge.js`

### Problem
The code enqueues the merged global lookup write with `pendingOps.push(...)` and then calls `await flushPendingOps()`. The helper flushes only when `pendingOps.length >= RAW_BATCH_CHUNK_SIZE`. For a single global write, this threshold is usually not met, meaning the write can remain buffered and never persisted before subsequent steps (`unifyRevdeps`, replica-pointer switch).

### Why this is serious
- Active replica may switch while lookup map write is missing.
- Identifier resolution after merge can observe stale/incomplete key↔id mapping.
- This can produce latent data corruption symptoms (wrong lookup misses, unnecessary reallocation, or semantic/id drift).

## 2) Deterministic allocation retries ignore attempt index

### Where
`backend/src/generators/incremental_graph/identifier_resolver.js`

### Problem
The allocator passes `() => ...` callback into `allocateNodeIdentifier(...)`, ignoring the `attempt` argument used by collision retries. In deterministic fallback mode (no `generateNodeIdentifier` implementation), retries generate the same candidate repeatedly and fail even though attempt-indexed deterministic alternatives are available.

### Why this is serious
- Collision handling is effectively disabled in fallback mode.
- Behavior becomes brittle for tests, compatibility doubles, and any environment without random-id generator wiring.

## 3) Pull-by-identifier path inconsistently uses resolved semantic key

### Where
`backend/src/generators/incremental_graph/pull.js`

### Problem
`requireNodeKey(nodeKeyStr)` resolves semantic key from identifier, but downstream concrete-node cache creation and mutex scoping still use original `nodeKeyStr` value. If caller passes persisted identifier, downstream logic can treat identifier string as semantic key material.

### Why this is serious
- Can poison concrete-node cache keys.
- Can create duplicate/incorrect node instantiations for same semantic node.
- Can cause wrong mapping during `getOrAllocateNodeIdentifier(concreteNode.output)`.
- Mutex key inconsistency can reduce deduplication of concurrent pulls of same semantic node.

## Root cause pattern
Across all three comments, the theme is **boundary consistency**:
- writes must be committed at durability boundaries,
- retry contracts must propagate fully,
- key-vs-identifier normalization must be applied once and used consistently afterward.
