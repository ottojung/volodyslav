# PR Analysis: #1335 and #1376

## PR #1335 — Identifier-native graph storage

### What it did

PR #1335 restructured the incremental-graph persistence layer so that every
node-data sublevel (`values`, `freshness`, `inputs`, `revdeps`, `counters`,
`timestamps`) is keyed by an opaque `NodeIdentifier` (a 9-character lowercase
string) rather than by the human-readable `NodeKeyString`.

Before this PR, code throughout `graph_storage.js` and its callers had to
translate between semantic keys and storage keys at every read and write.
After the PR, translation is done exactly once per graph operation — at the
top level — and all downstream code works exclusively with identifiers.

The `IdentifierLookup` bijection (`NodeKeyString ↔ NodeIdentifier`) is kept
in memory in `_computed.identifierLookup` and persisted in
`global/identifiers_keys_map` as a sorted array.

### Key design principle

> The translation from key to identifier must happen only once per operation,
> at the entry point (IncrementalGraph public API). GraphStorage must not know
> about NodeKey, NodeKeyString, "head + args", or semantic keys at all.

### What was left to do

The commit path in `withTransaction` still cloned the full identifier lookup
twice — at transaction start and again before committing — creating O(n log n)
overhead per transaction regardless of how many new identifiers were actually
allocated.

---

## PR #1376 — Volatile-consistency spec and implementation

### What it did

PR #1376 specified and then implemented the exact isomorphism guarantee between
the volatile layer (`_computed.identifierLookup`) and the persisted layer
(`global/identifiers_keys_map`).

The core invariant is:

> At every observable point (outside an active transaction), the volatile
> layer contains **exactly** the same entries as the persisted layer — no
> more and no fewer.

Two principles enforce this:

1. **Explicit over ambient.** Transaction context is passed as a direct
   function argument through the call stack. No `async_hooks`, no global
   state, no ambient context.

2. **Disk before memory.** The in-memory lookup is updated only after the
   LevelDB batch flush succeeds. A failed flush leaves both disk and memory
   unchanged.

`withComputedStateMutex` serializes all top-level graph operations. Nested
pulls (a computor calling `pull()` on a dependency) reuse the outer
transaction via explicit argument passing instead of re-acquiring the mutex
(which would deadlock).

The testable properties from the spec (P1–P9) are verified by
`incremental_graph_volatile_consistency.test.js`.

---

## Identified inefficiency: redundant cloning of the identifier lookup

### Where it is

In `graph_state.js`, `withTransaction()`:

```javascript
// createTransaction()
const identifierLookup = rootDatabase.cloneActiveIdentifierLookup();  // ❶ O(n log n) clone
const initialLookupSize = identifierLookup.keyToId.size;
const { batch, operations } = createBatch(activeSchemaStorage);
const tx = { batch, identifierLookup };

const value = await fn(tx);

// commitTransaction()
const hasPendingAllocations = tx.identifierLookup.keyToId.size > initialLookupSize;
if (hasPendingAllocations) {
    const lookupToCommit = cloneIdentifierLookup(tx.identifierLookup);  // ❷ O(n log n) clone
    operations.push(activeSchemaStorage.global.rawPutOp(
        IDENTIFIERS_KEY,
        serializeIdentifierLookup(lookupToCommit)    // ❸ O(n log n) sort
    ));
    await activeSchemaStorage.batch(operations);
    rootDatabase.replaceActiveIdentifierLookup(lookupToCommit);
} else {
    await activeSchemaStorage.batch(operations);
}
```

Clone ❶ is done **at the start of every transaction** — even read-only ones
or ones that access only already-known nodes. Clone ❷ is done at commit time
**in addition** to clone ❶, to produce a "safe" copy to hand to
`replaceActiveIdentifierLookup`. Both are O(n log n) where n is the total
number of ever-seen nodes, because `cloneIdentifierLookup` internally calls
`makeIdentifierLookup(serializeIdentifierLookup(lookup))`, which sorts all
entries before reconstructing both maps.

Only serialization ❸ is unavoidable (the disk format is a sorted array).
Clones ❶ and ❷ are pure waste.

### Why the clones were there

Clone ❶ provides a **mutable working copy** of the lookup so that allocations
during the transaction do not immediately mutate `_computed.identifierLookup`,
which would violate the "disk before memory" principle if the flush later
fails.

Clone ❷ ensures that the object stored in `_computed.identifierLookup` at
commit time is **not the same object** still referenced by `tx.identifierLookup`,
preventing any post-commit mutation of the committed state. In practice this
is unnecessary because the transaction is always discarded after `fn` returns.

### Other related inefficiencies

`mergeIdentifierLookups` in `identifier_lookup.js` also uses
`cloneIdentifierLookup` to copy the base before merging. This is used in the
sync-merge path (`sync_merge.js`) and is a separate, lower-frequency
allocation.

---

## New design: `TransactionIdentifierLookup` overlay

### Core idea

Instead of cloning the full lookup at transaction start, give the transaction:

- A **read-only reference** to `_computed.identifierLookup` (the base — never
  mutated during the transaction).
- A **small mutable overlay** (`Map`) for new allocations made during this
  transaction only.

Lookups check the overlay first, then fall through to the base. Allocations
write to the overlay only. At commit time:

1. Serialize (base + overlay) together for the disk write (one O((n+k) log(n+k))
   sort, where k is the number of new allocations in this transaction — usually
   very small).
2. Flush to disk.
3. **Only after a successful flush**: apply the overlay entries to the base
   in-place (O(k) direct Map.set calls). No second clone.

If the flush fails, the overlay is simply discarded. The base is never touched.

### Type

```javascript
/**
 * @typedef {object} TransactionIdentifierLookup
 * @property {Map<string, NodeIdentifier>} keyToId - New allocations this transaction only.
 * @property {Map<string, NodeKeyString>} idToKey  - New allocations this transaction only (inverse).
 * @property {IdentifierLookup} base               - Read-only reference to the committed lookup.
 */
```

### New functions

| Function | Description |
|---|---|
| `makeTransactionIdentifierLookup(base)` | Create an empty overlay backed by `base`. O(1). |
| `txNodeKeyToId(txLookup, nodeKey)` | Check overlay, fall through to base. O(1). |
| `txNodeIdToKey(txLookup, nodeId)` | Check overlay, fall through to base. O(1). |
| `txAllocateNodeIdentifier(txLookup, nodeKey, make)` | Allocate into overlay, collision-check both. O(1) amortized. |
| `serializeTransactionLookup(txLookup)` | Serialize base + overlay for disk. O((n+k) log(n+k)). |
| `commitTransactionLookup(txLookup)` | Apply overlay to base in-place. O(k). Call only after flush. |

### Performance impact

| Scenario | Old | New |
|---|---|---|
| Read-only transaction (all nodes known) | 1× O(n log n) clone | 0 clones, O(1) |
| Transaction with k new allocations | 2× O(n log n) clones + 1× O(n log n) sort | 0 clones + 1× O((n+k) log(n+k)) sort |

### Correctness preservation

- `withComputedStateMutex` still serializes all transactions. No concurrent
  transaction can see a partial overlay application.
- The base (`_computed.identifierLookup`) is mutated (by `commitTransactionLookup`)
  only after a successful flush, preserving the "disk before memory" invariant.
- Replica cutovers run under `withExclusiveMode`, which blocks all in-flight
  pulls. When `_computed` is replaced during a cutover, no transaction holds a
  reference to the old base; the next transaction gets the new base via
  `getActiveIdentifierLookup()`.
- The `cloneActiveIdentifierLookup()` method is kept on `RootDatabase` for
  external inspection (tests) and is not called inside `withTransaction`.
- All existing testable properties P1–P9 from the spec continue to hold.
