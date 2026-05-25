# Deep Analysis of PR #1335 and PR #1376

## PR #1335 — Switch IncrementalGraph Persistence and Migration to Node Identifiers

### What the PR Does

Before this PR, the `IncrementalGraph` database stored node data keyed by **semantic node-key strings** (e.g., `'{"head":"calories","args":[{"id":5}]}'`). This meant that every sublevel (`values`, `freshness`, `inputs`, `revdeps`, `counters`, `timestamps`) used human-readable strings as database keys.

The PR replaces those semantic keys with **opaque 9-character node identifiers** (e.g., `'azbcqxwrt'`). The semantic bijection — the mapping between identifiers and keys — is stored once in a dedicated `global` sublevel under `'identifiers_keys_map'`.

### Architecture after the PR

```
Before: sublevel[semanticKeyString] = value
After:  sublevel[nodeIdentifier]    = value
        global['identifiers_keys_map'] = [{id, key}, ...]  ← bijection
```

The translation from semantic key to identifier happens **once** per graph operation, at the boundary between `class.js` (the public API) and `graph_storage.js` (the storage layer). From that point inward, only identifiers are used.

### Key Decisions Driven by Review

**`graph_storage.js` must know nothing about `NodeKey` or semantic strings.** The reviewer explicitly banned `NodeKeyString` from `graph_storage.js`. The semantic-to-identifier translation must happen at the `IncrementalGraph` public API layer (in `class.js` / `pull.js`), not inside the storage layer.

**Migration must be correct and bijective.** The migration runner reads the old (key-addressed) database, assigns a deterministic identifier to each key (using a SHA-256-derived 9-char lowercase string), and rewrites all sublevels under identifier keys. The identifier assignment is deterministic so repeated migrations of the same data produce the same identifiers.

**Tests must not be deleted.** Every failing test must be fixed by fixing the implementation, not by removing the test. The migration fixture test (`migration_fixture_populated_remote.test.js`) is the most important correctness check — it compares the migrated database against a golden snapshot.

### Core Data Flow

```
graph.pull("calories")
  → serializeNodeKey({head:"calories", args:[...]})  → NodeKeyString
  → tx.identifierLookup.keyToId.get(keyString)       → NodeIdentifier | allocate new
  → storage.values.get(nodeIdentifier)               → value
```

The identifier lookup is loaded once at database open time and kept in `_computed.identifierLookup`. New allocations are written to disk atomically alongside node data writes (disk-first ordering).

### The `_computed` Volatile Layer

`RootDatabase._computed` mirrors the active replica's on-disk state:
- `replicaName` — which replica slot ('x' or 'y') is active
- `namespaceSublevel` / `globalSublevel` — LevelDB handles
- `schemaStorage` — typed sublevel accessors
- `identifierLookup` — the in-memory bijection

A replica cutover replaces all of `_computed` atomically, including the identifier lookup.

---

## PR #1376 — Add PR #1335 Analysis Docs, Volatile-Consistency Spec, and Implementation

### What the PR Does

This PR has two distinct phases:

**Phase 1 — Documentation and spec.** It adds a formal specification at `docs/specs/incremental-graph-volatile-consistency.md` that captures the consistency guarantee of the `_computed` layer: *at every observable point (outside a transaction), the volatile `identifierLookup` is exactly isomorphic to the persisted `identifiers_keys_map`*.

**Phase 2 — Implementation.** It implements the spec:
- `lock.js` fixes a misleading doc comment on `withComputedStateMutex`.
- `class.js` fixes `popActivePullContext` to find frames by identity rather than assuming LIFO order (important for out-of-order parallel nested pull completion).
- `graph_state.js` implements the disk-first transaction model: new identifier allocations are flushed to disk **before** `_computed.identifierLookup` is updated.
- A new test file `incremental_graph_volatile_consistency.test.js` provides conformance tests for spec properties P1–P9.

### The Key Consistency Invariant

At every observable point (outside the graph mutex):

```
_computed.identifierLookup  ≡  persisted identifiers_keys_map
```

No more, no fewer entries. The volatile layer is not a superset of the persisted layer — it is exactly isomorphic to it.

### The Disk-First Protocol

When a transaction allocates new identifiers:
1. Append the updated `identifiers_keys_map` to the LevelDB batch.
2. Flush the batch atomically to disk.
3. **Only after a successful flush**: update `_computed.identifierLookup`.
4. On flush failure: leave `_computed.identifierLookup` unchanged.

This prevents the "ahead-of-disk" state where the volatile layer would know about an identifier that was never persisted.

### Transaction Model

A transaction encapsulates:
- `batch` — a LevelDB batch accumulator with read-your-writes overlay
- `identifierLookup` — a **clone** of the committed lookup, extended in-place with new allocations

Nested dependency pulls reuse the same transaction (passed explicitly). The graph mutex serializes all top-level operations, preventing concurrent identifier allocation races.

### What the Review Discussion Revealed

1. The volatile layer must be **exactly isomorphic** to the persisted layer — not merely a superset. This changes the invariant from a one-directional containment to a full bijection.
2. The disk-first ordering is a correctness requirement, not just an optimization.
3. `popActivePullContext` had a latent bug where out-of-order completion of parallel nested pulls could remove the wrong frame from the active-pull stack.

---

## Cross-Cutting Observations

### The Cloning Inefficiency

Both PRs rely on `cloneActiveIdentifierLookup()` / `cloneIdentifierLookup()` — an O(n) deep copy of the full identifier bijection — at the start of **every top-level graph operation**. A second clone is made at commit time (`cloneIdentifierLookup(tx.identifierLookup)`) before serializing the updated lookup to disk.

For a large graph with thousands of nodes, this means every `pull()` or `invalidate()` allocates two full copies of the identifier lookup, even when the operation adds zero new identifiers (the common case once the graph is warm).

The root cause is a design choice: the transaction holds a working copy of the lookup (to isolate in-progress allocations from committed state), and this working copy is created by deep-cloning the committed lookup. At commit time, the working copy is again cloned to produce the version that is serialized to disk.

### Why This Is Problematic

- **CPU and GC pressure**: Every graph operation, including cache hits, clones the full lookup.
- **No type-system enforcement**: The `IdentifierLookup` type exposes raw `Map` fields (`keyToId`, `idToKey`), so any code anywhere can clone or mutate the lookup without going through the provided API.
- **Fragility**: The clone-and-replace pattern (`replaceActiveIdentifierLookup`) is only correct under the mutex. Any code that clones the lookup at the wrong time could observe stale state.

### The New Design (implemented in this branch)

See the implementation changes in this PR. The key ideas:

1. **`IdentifierLookup` becomes opaque.** The `keyToId` and `idToKey` Maps are hidden behind a WeakMap. External code can only access the lookup through provided query functions (`nodeKeyToIdFromLookup`, `nodeIdToKeyFromLookup`, `serializeIdentifierLookup`, `getIdentifierLookupSize`). Cloning is forbidden because there is no `clone` function and the internal state is inaccessible.

2. **Transactions use an overlay, not a clone.** Instead of cloning the entire committed lookup at transaction start, a transaction carries:
   - A **reference** to the live committed lookup (no copy).
   - An **empty `_pendingAllocations` lookup** for new identifiers allocated during this transaction.
   
   Reads check `_pendingAllocations` first, then fall through to the committed lookup. Allocations go into `_pendingAllocations` only.

3. **Commit merges in-place.** After a successful disk flush, the pending allocations are merged into the committed lookup in-place (`mergeIdentifierLookupInto`). No new lookup object is created; the active lookup is mutated atomically under the mutex.

4. **`cloneIdentifierLookup` and `cloneActiveIdentifierLookup` are removed.** Their removal is enforced by the opaque type: since the Maps are inaccessible, there is no way to implement a clone outside the module.
