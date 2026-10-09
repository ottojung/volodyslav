const {
    compareNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("./node_identifier");
const { nodeKeyStringToString } = require("./types");

/** @typedef {import("./types").NodeIdentifier} NodeIdentifier */
/** @typedef {import("./types").NodeKeyString} NodeKeyString */
/** @typedef {import("./types").IdentifiersKeysMap} IdentifiersKeysMap */

/**
 * Global metadata key that stores the sorted `NodeIdentifier -> NodeKey` bijection.
 * The name matches the persisted on-disk/database format described in the design doc.
 */
const IDENTIFIERS_KEY = "identifiers_keys_map";

/**
 * Thrown when the in-memory or persisted identifier lookup stops being a bijection.
 */
class IdentifierLookupError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "IdentifierLookupError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is IdentifierLookupError}
 */
function isIdentifierLookupError(object) {
    return object instanceof IdentifierLookupError;
}

/**
 * Committed identifier lookup used as the in-memory mirror of the persisted
 * `identifiers_keys_map`. Both maps always contain exactly the same entries
 * as the on-disk record at every observable point (outside a transaction).
 *
 * The `serialized` field caches the persisted sorted-array form so that
 * `serializeTransactionLookup` avoids re-iterating and re-sorting the entire
 * Map on every transaction commit.
 *
 * @typedef {object} IdentifierLookup
 * @property {Map<string, NodeIdentifier>} keyToId - Semantic node key string -> deterministic identifier.
 * @property {Map<string, NodeKeyString>} idToKey - Deterministic identifier string -> semantic node key string.
 * @property {IdentifiersKeysMap} serialized - Cached sorted-array form sorted by identifier.
 */

/**
 * Transaction-scoped overlay over a committed `IdentifierLookup`.
 *
 * Only new allocations made **during this transaction** are stored in the
 * overlay maps (`keyToId`, `idToKey`). The underlying committed lookup is
 * held in `base` as a read-only reference and is never mutated during the
 * transaction.
 *
 * At commit time (after a successful disk flush) the overlay is applied to
 * `base` in-place via `commitTransactionLookup`, making the committed lookup
 * reflect the new entries without any full-clone operation.
 *
 * @typedef {object} TransactionIdentifierLookup
 * @property {Map<string, NodeIdentifier>} keyToId - New allocations in this transaction only.
 * @property {Map<string, NodeKeyString>} idToKey  - New allocations in this transaction only (inverse).
 * @property {IdentifierLookup} base               - Read-only reference to the committed lookup.
 * @property {Set<string>} ownedKeys              - Key strings allocated by this transaction (tracked for releaseIdentifierReservations cleanup).
 */

/**
 * @returns {IdentifierLookup}
 */
function makeEmptyIdentifierLookup() {
    return {
        keyToId: new Map(),
        idToKey: new Map(),
        serialized: [],
    };
}

/**
 * Build a validated in-memory lookup from persisted `[id, key]` entries.
 * The input must already be a strict bijection and sorted by identifier.
 * @param {IdentifiersKeysMap} entries
 * @returns {IdentifierLookup}
 */
function makeIdentifierLookup(entries) {
    const lookup = makeEmptyIdentifierLookup();
    for (const [nodeIdentifier, nodeKey] of entries) {
        const identifierString = nodeIdentifierToString(nodeIdentifier);
        const nodeKeyString = nodeKeyStringToString(nodeKey);
        if (lookup.idToKey.has(identifierString)) {
            throw new IdentifierLookupError(`Duplicate node identifier in lookup map: ${identifierString}`);
        }
        if (lookup.keyToId.has(nodeKeyString)) {
            throw new IdentifierLookupError(`Duplicate node key in lookup map: ${nodeKeyString}`);
        }
        lookup.idToKey.set(identifierString, nodeKey);
        lookup.keyToId.set(nodeKeyString, nodeIdentifier);
    }
    // Build and cache the sorted-array form so the hot path (serializeTransactionLookup)
    // never needs to re-iterate the Maps or sort.
    lookup.serialized = serializeIdentifierLookupFromMaps(lookup);
    return lookup;
}

/**
 * Clone a lookup by direct Map iteration.
 * @param {IdentifierLookup} lookup
 * @returns {IdentifierLookup}
 */
function cloneIdentifierLookup(lookup) {
    return {
        keyToId: new Map(lookup.keyToId),
        idToKey: new Map(lookup.idToKey),
        serialized: lookup.serialized,
    };
}

/**
 * Build the sorted-array form from the Maps directly (fallback / cold path).
 * @param {IdentifierLookup} lookup
 * @returns {IdentifiersKeysMap}
 */
function serializeIdentifierLookupFromMaps(lookup) {
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const [identifierString, nodeKey] of lookup.idToKey.entries()) {
        entries.push([nodeIdentifierFromString(identifierString), nodeKey]);
    }
    entries.sort(([a], [b]) => compareNodeIdentifier(a, b));
    return entries;
}

/**
 * Return the lookup in its persisted form, sorted by identifier string.
 *
 * Returns the cached `serialized` array when the cache is consistent with
 * the Maps.  Batch mutations (commitTransactionLookup, mergeIdentifierLookups)
 * update the cache themselves.  Individual mutations (setIdentifierMapping,
 * deleteIdentifierMappingForNodeKey) mutate only the Maps; the next call
 * here detects the size mismatch and rebuilds.  This keeps individual
 * mutations O(1) and rebuilds O(n log n) only when actually stale.
 *
 * @param {IdentifierLookup} lookup
 * @returns {IdentifiersKeysMap}
 */
function serializeIdentifierLookup(lookup) {
    if (lookup.serialized.length !== lookup.idToKey.size) {
        lookup.serialized = serializeIdentifierLookupFromMaps(lookup);
    }
    return lookup.serialized;
}

/**
 * Read the identifier currently assigned to a semantic node key.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function nodeKeyToIdFromLookup(lookup, nodeKey) {
    return lookup.keyToId.get(nodeKeyStringToString(nodeKey));
}

/**
 * Read the semantic node key currently assigned to an identifier.
 * @param {IdentifierLookup} lookup
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString | undefined}
 */
function nodeIdToKeyFromLookup(lookup, nodeIdentifier) {
    return lookup.idToKey.get(nodeIdentifierToString(nodeIdentifier));
}

/**
 * Insert or re-assert a mapping in the bijection.
 * This throws if either side is already associated with a different counterpart.
 * @param {IdentifierLookup} lookup
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeKeyString} nodeKey
 * @returns {void}
 */
function setIdentifierMapping(lookup, nodeIdentifier, nodeKey) {
    const identifierString = nodeIdentifierToString(nodeIdentifier);
    const nodeKeyString = nodeKeyStringToString(nodeKey);
    const existingKey = lookup.idToKey.get(identifierString);
    if (existingKey !== undefined && existingKey !== nodeKey) {
        throw new IdentifierLookupError(
            `Node identifier ${identifierString} is already assigned to ${nodeKeyStringToString(existingKey)}`
        );
    }
    const existingIdentifier = lookup.keyToId.get(nodeKeyString);
    if (existingIdentifier !== undefined && existingIdentifier !== nodeIdentifier) {
        throw new IdentifierLookupError(
            `Node key ${nodeKeyString} is already assigned to ${nodeIdentifierToString(existingIdentifier)}`
        );
    }
    lookup.idToKey.set(identifierString, nodeKey);
    lookup.keyToId.set(nodeKeyString, nodeIdentifier);
}

/**
 * Remove the mapping for a semantic node key if one exists.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @returns {void}
 */
function deleteIdentifierMappingForNodeKey(lookup, nodeKey) {
    const nodeKeyString = nodeKeyStringToString(nodeKey);
    const existingIdentifier = lookup.keyToId.get(nodeKeyString);
    if (existingIdentifier === undefined) {
        return;
    }
    lookup.keyToId.delete(nodeKeyString);
    lookup.idToKey.delete(nodeIdentifierToString(existingIdentifier));
}

/**
 * Merge overlay mappings into base in-place and update the serialized cache.
 * No clone is performed — the overlay entries are written directly into `base`
 * via `setIdentifierMapping`.
 *
 * Conflicts are still caught by `setIdentifierMapping` (which throws
 * on disagreement), but `assertNoIdentifierLookupConflicts` in the caller
 * already guarantees no conflicts exist before this runs.
 * @param {IdentifierLookup} base
 * @param {IdentifierLookup} overlay
 * @returns {void}
 */
function mergeIdentifierLookups(base, overlay) {
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const newEntries = [];
    for (const [identifierString, nodeKey] of overlay.idToKey.entries()) {
        if (!base.idToKey.has(identifierString)) {
            newEntries.push([nodeIdentifierFromString(identifierString), nodeKey]);
        }
        setIdentifierMapping(
            base,
            nodeIdentifierFromString(identifierString),
            nodeKey
        );
    }
    if (newEntries.length > 0) {
        newEntries.sort(([a], [b]) => compareNodeIdentifier(a, b));
        base.serialized = mergeSorted(base.serialized, newEntries);
    }
}

/**
 * Allocate a fresh identifier for a node key.
 * If the key already has an identifier, the existing identifier is reused.
 * Collisions are impossible with fingerprint-prefixed identifiers; the check
 * exists as a correctness assertion only.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @param {() => NodeIdentifier} makeIdentifier
 * @returns {NodeIdentifier}
 */
function allocateNodeIdentifier(lookup, nodeKey, makeIdentifier) {
    const existing = nodeKeyToIdFromLookup(lookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    const candidate = makeIdentifier();
    const existingKey = nodeIdToKeyFromLookup(lookup, candidate);
    if (existingKey !== undefined) {
        throw new IdentifierLookupError(
            `Identifier collision: ${nodeIdentifierToString(candidate)} already assigned`
        );
    }
    setIdentifierMapping(lookup, candidate, nodeKey);
    return candidate;
}

/**
 * Require the semantic node key for an identifier.
 * @param {IdentifierLookup} lookup
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString}
 */
function requireNodeKeyForIdentifier(lookup, nodeIdentifier) {
    const nodeKey = nodeIdToKeyFromLookup(lookup, nodeIdentifier);
    if (nodeKey === undefined) {
        throw new IdentifierLookupError(
            `Missing node key for identifier ${nodeIdentifierToString(nodeIdentifier)}`
        );
    }
    return nodeKey;
}

/**
 * Require the identifier for a semantic node key.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function requireNodeIdentifierForKey(lookup, nodeKey) {
    const nodeIdentifier = nodeKeyToIdFromLookup(lookup, nodeKey);
    if (nodeIdentifier === undefined) {
        throw new IdentifierLookupError(
            `Missing node identifier for key ${nodeKeyStringToString(nodeKey)}`
        );
    }
    return nodeIdentifier;
}

// ---------------------------------------------------------------------------
// TransactionIdentifierLookup helpers
// ---------------------------------------------------------------------------

/**
 * Create an empty transaction lookup overlay backed by the given committed lookup.
 * The overlay starts empty; new allocations are written into it during the transaction.
 * The base is never mutated by transaction operations.
 * @param {IdentifierLookup} baseLookup - The committed in-memory lookup (read-only reference).
 * @returns {TransactionIdentifierLookup}
 */
function makeTransactionIdentifierLookup(baseLookup) {
    return {
        keyToId: new Map(),
        idToKey: new Map(),
        base: baseLookup,
        ownedKeys: new Set(),
    };
}

/**
 * Look up the identifier for a semantic node key within a transaction.
 * Checks the overlay first, then falls through to the committed base.
 * @param {TransactionIdentifierLookup} txLookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function txNodeKeyToId(txLookup, nodeKey) {
    const keyString = nodeKeyStringToString(nodeKey);
    return txLookup.keyToId.get(keyString) ?? txLookup.base.keyToId.get(keyString);
}

/**
 * Look up the semantic node key for an identifier within a transaction.
 * Checks the overlay first, then falls through to the committed base.
 * @param {TransactionIdentifierLookup} txLookup
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString | undefined}
 */
function txNodeIdToKey(txLookup, nodeIdentifier) {
    const idString = nodeIdentifierToString(nodeIdentifier);
    return txLookup.idToKey.get(idString) ?? txLookup.base.idToKey.get(idString);
}

/**
 * Return the existing identifier for a node key, or allocate a new one and
 * record it in the overlay (never in the base).
 *
 * Allocation is delegated to `rootDatabase._allocateKeyIdentifier`.  The
 * caller must hold the telescope lock for the node key (see pull.js), which
 * serialises all concurrent attempts for the same key.
 *
 * The newly allocated key is added to `txLookup.ownedKeys` so the
 * transaction's `finally` block can release the reservation from
 * `_pendingAllocations`.
 *
 * @param {TransactionIdentifierLookup} txLookup
 * @param {NodeKeyString} nodeKey
 * @param {() => NodeIdentifier} makeIdentifier
 * @param {import('./root_database').RootDatabase} rootDatabase
 * @returns {NodeIdentifier}
 */
function txAllocateNodeIdentifier(
    txLookup,
    nodeKey,
    makeIdentifier,
    rootDatabase,
) {
    const existing = txNodeKeyToId(txLookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    const keyString = nodeKeyStringToString(nodeKey);
    const identifier = rootDatabase._allocateKeyIdentifier(
        keyString,
        makeIdentifier,
        txLookup.base,
    );

    txLookup.keyToId.set(keyString, identifier);
    txLookup.idToKey.set(nodeIdentifierToString(identifier), nodeKey);
    txLookup.ownedKeys.add(keyString);

    return identifier;
}

/**
 * Merge two sorted arrays of `[NodeIdentifier, NodeKeyString]` pairs into one
 * sorted array. Both inputs must already be sorted by identifier.
 *
 * Uses iterators instead of indexed access so that TypeScript's
 * `noUncheckedIndexedAccess` does not force |undefined on every element.
 *
 * @param {IdentifiersKeysMap} sortedA
 * @param {IdentifiersKeysMap} sortedB
 * @returns {IdentifiersKeysMap}
 */
function mergeSorted(sortedA, sortedB) {
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const result = [];

    const iterA = sortedA[Symbol.iterator]();
    const iterB = sortedB[Symbol.iterator]();
    let a = iterA.next();
    let b = iterB.next();

    while (!a.done && !b.done) {
        if (compareNodeIdentifier(a.value[0], b.value[0]) <= 0) {
            result.push(a.value);
            a = iterA.next();
        } else {
            result.push(b.value);
            b = iterB.next();
        }
    }

    while (!a.done) {
        result.push(a.value);
        a = iterA.next();
    }
    while (!b.done) {
        result.push(b.value);
        b = iterB.next();
    }

    return result;
}

/**
 * Serialize the combined (base + overlay) lookup into the sorted-array format
 * used for disk persistence.
 *
 * Uses the base's cached sorted array and merges in any overlay entries not
 * already present in the base (the base may be stale if another concurrent
 * transaction committed entries for different keys between this transaction's
 * allocation and its commit). The base cache is always up to date because
 * `commitTransactionLookup` updates it after every successful commit.
 *
 * Call this **before** `commitTransactionLookup` so that the base is still
 * unmodified while serializing.
 *
 * Returns the cached array directly when there are no new entries — the
 * caller (a batch put operation) does not mutate the result, so no defensive
 * copy is needed.
 *
 * @param {TransactionIdentifierLookup} txLookup
 * @returns {IdentifiersKeysMap}
 */
function serializeTransactionLookup(txLookup) {
    const base = txLookup.base;

    if (txLookup.idToKey.size === 0) {
        return base.serialized;
    }

    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const newEntries = [];
    for (const [idString, nodeKey] of txLookup.idToKey) {
        if (!base.idToKey.has(idString)) {
            newEntries.push([nodeIdentifierFromString(idString), nodeKey]);
        }
    }

    if (newEntries.length === 0) {
        return base.serialized;
    }

    newEntries.sort(([a], [b]) => compareNodeIdentifier(a, b));
    return mergeSorted(base.serialized, newEntries);
}

/**
 * Apply all overlay entries from a committed transaction to the base lookup
 * in-place. Must be called **only after** a successful disk flush so that the
 * "disk before memory" invariant is preserved.
 *
 * After this call the overlay is exhausted into the base and should not be
 * used again; the transaction object itself is discarded.
 *
 * Updates the base's `serialized` cache so subsequent calls to
 * `serializeTransactionLookup` avoid re-iterating the entire Map.
 *
 * ### Why this bypasses setIdentifierMapping checks
 *
 * This function writes directly into `base.keyToId` and `base.idToKey` rather
 * than calling `setIdentifierMapping`, which checks that neither side of the
 * bijection is already bound to a different counterpart.  The checks are
 * unnecessary here because:
 *
 * 1. **Telescope lock prevents conflicts.**  Every allocation runs inside
 *    `telescopeActivity(key)` (see pull.js), which serialises all concurrent
 *    pulls of the same concrete node key.  Two concurrent transactions cannot
 *    allocate different identifiers for the same key.
 *
 * 2. **Idempotent overwrite.**  When a transaction's base reference becomes
 *    stale (another concurrent transaction already committed the same entry),
 *    the write is a no-op: `base.keyToId` and `base.idToKey` already contain
 *    the same mapping.  The `if (!txLookup.base.idToKey.has(idString))` guard
 *    on the serialized-cache merge ensures the sorted array does not get
 *    duplicates.
 *
 * 3. **Disk before memory.**  By the time this runs the data is already
 *    persisted to the global `identifiers_keys_map`.  The in-memory mirrors
 *    are just a cache of what's already on disk.
 *
 * @param {TransactionIdentifierLookup} txLookup
 * @returns {void}
 */
function commitTransactionLookup(txLookup) {
    for (const [keyString, id] of txLookup.keyToId) {
        txLookup.base.keyToId.set(keyString, id);
    }

    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const newEntries = [];
    for (const [idString, nodeKey] of txLookup.idToKey) {
        if (!txLookup.base.idToKey.has(idString)) {
            newEntries.push([nodeIdentifierFromString(idString), nodeKey]);
        }
        txLookup.base.idToKey.set(idString, nodeKey);
    }

    if (newEntries.length > 0) {
        newEntries.sort(([a], [b]) => compareNodeIdentifier(a, b));
        txLookup.base.serialized = mergeSorted(txLookup.base.serialized, newEntries);
    }
}

module.exports = {
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    mergeIdentifierLookups,
    deleteIdentifierMappingForNodeKey,
    IdentifierLookupError,
    IDENTIFIERS_KEY,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    makeTransactionIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
    txAllocateNodeIdentifier,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
};
