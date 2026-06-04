# Issue P4 — `setCurrentReplicaPointer` rebuilding `_computed` from scratch

**TL;DR:** The concern is that `setCurrentReplicaPointer` opens new LevelDB sublevel handles and reads the entire identifier lookup from disk every time it's called, whereas the old code cached both replicas' state in memory. In practice this is fine because the method is called rarely (migration cutover, tests), not on every pull.

---

## What the review said

> "`_computed.loadData` could be expensive... `setCurrentReplicaPointer` also calls it after every cutover. If replicas are switched frequently, this could be a performance concern."

The method `_computed.loadData` doesn't actually exist in the code — the concern is about what `setCurrentReplicaPointer` does internally: it reconstructs the entire `_computed` object by opening LevelDB sublevels and reading all identifier mappings from disk.

---

## Old design (`switchToReplica`, before this PR)

The constructor pre-built **both** replicas' sublevel handles and schema storages:

```js
// constructor — both replicas always ready
this._xNamespaceSublevel = db.sublevel('x', ...);
this._yNamespaceSublevel = db.sublevel('y', ...);
this._xGlobalSublevel = this._xNamespaceSublevel.sublevel('global', ...);
this._yGlobalSublevel = this._yNamespaceSublevel.sublevel('global', ...);
this._xSchemaStorage = buildSchemaStorage(this._xNamespaceSublevel, this._xGlobalSublevel, version);
this._ySchemaStorage = buildSchemaStorage(this._yNamespaceSublevel, this._yGlobalSublevel, version);

async switchToReplica(name) {
    await this._rootMetaSublevel.put('current_replica', name);
    this._cachedValueOfCurrentReplica = name;  // ← just a pointer swap
}
```

Switching was O(1): a single put + a scalar assignment. No I/O, no parsing.

---

## New design (`setCurrentReplicaPointer`, this PR)

The constructor now builds only the **active** replica's state in `_computed`. The inactive replica's handles are not retained:

```js
// constructor — only active replica
const namespaceSublevel = this.replicaNamespaceSublevel(currentReplicaName);
const globalSublevel = this.replicaGlobalSublevel(currentReplicaName);
this._computed = {
    replicaName: currentReplicaName,
    namespaceSublevel,
    globalSublevel,
    schemaStorage: buildSchemaStorage(namespaceSublevel, globalSublevel, version),
    identifierLookup: makeEmptyIdentifierLookup(),
};
```

When switching, the full state must be reconstructed from disk:

```js
async setCurrentReplicaPointer(name) {
    const namespaceSublevel = this.replicaNamespaceSublevel(name);  // db.sublevel('x', ...)
    const globalSublevel = this.replicaGlobalSublevel(name);        // .sublevel('global', ...)
    const schemaStorage = buildSchemaStorage(namespaceSublevel, globalSublevel, this.version);
    // ...
    const identifierLookup = await loadIdentifierLookupFromGlobal(  // ← reads ALL entries from LevelDB
        globalSublevel,
        `replica '${name}'`
    );
    // ...
    this._computed = { replicaName: name, namespaceSublevel, globalSublevel, schemaStorage, identifierLookup };
}
```

This involves:
1. Two `sublevel()` calls (LevelDB sublevel creation — cheap, no I/O).
2. `loadIdentifierLookupFromGlobal` — a full scan of the `identifiers_keys_map` sublevel, deserializing all entries into the in-memory `IdentifierLookup` (a `Map`). Cost is proportional to the number of allocated identifiers.

---

## Why this is acceptable

### Usage frequency

`setCurrentReplicaPointer` is called in exactly these production paths:
- **`migration-runner.js:2798`** — once during migration cutover
- **`migrate.js:3660`** — once during schema migration

In both cases it's called **once per process session**. Normal pull and invalidate operations use `withTransaction` and `getSchemaStorage()` / `getActiveIdentifierLookup()`, which read from the already-loaded `_computed` — they never trigger a reload.

### Sublevel creation is cheap

`db.sublevel()` is a synchronous factory method that returns a lightweight wrapper. It does no I/O and doesn't open files.

### Identifier lookup size

The identifier lookup is bounded by the number of distinct node keys ever pulled. For a personal event logging system this is expected to be in the hundreds to low thousands — a full read is sub-millisecond.

### Architectural benefit

The old design held **both** replicas' schema storages and global sublevels in memory at all times. For a replica pair this is only 2× overhead, but the principle is cleaner: **memory footprint scales with the active replica only, not with all replicas**. This will matter if the number of replicas ever grows (e.g., a multi-region setup).

---

## When it could be a problem

- **Replica-per-request pattern**: If someone adds a code path that calls `setCurrentReplicaPointer` on every pull (e.g., round-robin between replicas for load balancing), the full LevelDB read on each call would be a bottleneck.
- **Very large identifier spaces**: If the system accumulates millions of node keys (unlikely for a personal tool), the full scan could take tens of milliseconds.

Neither scenario is realistic for this application given its design constraints (non-adversarial client, personal tool, bounded data size).

---

## Conclusion

**Not a real concern.** The old design was O(1) but kept both replicas' state resident. The new design is O(N) on cutover but only keeps the active replica in memory. Since cutover happens at most once per session and the N is small, this is an acceptable tradeoff for cleaner architecture. No changes needed.
