const crypto = require("crypto");

const {
    compareNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("./node_identifier");
const { nodeKeyStringToString } = require("./types");

/** @typedef {import("./types").NodeIdentifier} NodeIdentifier */
/** @typedef {import("./types").NodeKeyString} NodeKeyString */

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

class IdentifierAllocationError extends Error {
    /**
     * @param {string} nodeKey
     */
    constructor(nodeKey) {
        super(`Failed to allocate a unique node identifier for ${nodeKey}`);
        this.name = "IdentifierAllocationError";
        this.nodeKey = nodeKey;
    }
}

/**
 * @param {unknown} object
 * @returns {object is IdentifierAllocationError}
 */
function isIdentifierAllocationError(object) {
    return object instanceof IdentifierAllocationError;
}

/**
 * Committed identifier lookup used as the in-memory mirror of the persisted
 * `identifiers_keys_map`. Both maps always contain exactly the same entries
 * as the on-disk record at every observable point (outside a transaction).
 *
 * @typedef {object} IdentifierLookup
 * @property {Map<string, NodeIdentifier>} keyToId - Semantic node key string -> opaque identifier.
 * @property {Map<string, NodeKeyString>} idToKey - Opaque identifier string -> semantic node key string.
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
 */

/**
 * @returns {IdentifierLookup}
 */
function makeEmptyIdentifierLookup() {
    return {
        keyToId: new Map(),
        idToKey: new Map(),
    };
}

/**
 * Build a validated in-memory lookup from persisted `[id, key]` entries.
 * The input must already be a strict bijection.
 * @param {Array<[NodeIdentifier, NodeKeyString]>} entries
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
    return lookup;
}

/**
 * Clone the lookup through the persisted representation so validation stays centralized.
 * @param {IdentifierLookup} lookup
 * @returns {IdentifierLookup}
 */
function cloneIdentifierLookup(lookup) {
    return makeIdentifierLookup(serializeIdentifierLookup(lookup));
}

/**
 * Convert the lookup back into its persisted form, sorted by identifier string.
 * @param {IdentifierLookup} lookup
 * @returns {Array<[NodeIdentifier, NodeKeyString]>}
 */
function serializeIdentifierLookup(lookup) {
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const [identifierString, nodeKey] of lookup.idToKey.entries()) {
        entries.push([
            nodeIdentifierFromString(identifierString),
            nodeKey,
        ]);
    }
    entries.sort(([leftIdentifier], [rightIdentifier]) =>
        compareNodeIdentifier(leftIdentifier, rightIdentifier)
    );
    return entries;
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
 * Deterministically derive the legacy-migration identifier candidate for a node key.
 * Retry attempts perturb the hash input so collision handling is deterministic.
 * @param {NodeKeyString} nodeKey
 * @param {number} attempt
 * @returns {NodeIdentifier}
 */
function deterministicNodeIdentifierFromNodeKey(nodeKey, attempt = 0) {
    const nodeKeyString = nodeKeyStringToString(nodeKey);
    const digest = crypto
        .createHash("sha256")
        .update(`${nodeKeyString}:${String(attempt)}`)
        .digest();

    let identifier = "";
    for (let index = 0; index < 9; index++) {
        const value = digest[index];
        if (value === undefined) {
            throw new Error("deterministicNodeIdentifierFromNodeKey: missing hash byte");
        }
        identifier += String.fromCharCode("a".charCodeAt(0) + (value % 26));
    }
    return nodeIdentifierFromString(identifier);
}

/**
 * Merge two lookup snapshots by applying overlay mappings onto base.
 * Conflicting assignments throw `IdentifierLookupError` via `setIdentifierMapping`.
 *
 * Note: we intentionally do not add extra per-entry NodeIdentifier validation here,
 * because identifiers are already validated at construction boundaries and repeating
 * it on every merge would be wasted compute in a hot path.
 * @param {IdentifierLookup} base
 * @param {IdentifierLookup} overlay
 * @returns {IdentifierLookup}
 */
function mergeIdentifierLookups(base, overlay) {
    const merged = cloneIdentifierLookup(base);
    for (const [identifierString, nodeKey] of overlay.idToKey.entries()) {
        setIdentifierMapping(
            merged,
            nodeIdentifierFromString(identifierString),
            nodeKey
        );
    }
    return merged;
}

/**
 * Allocate a fresh identifier for a node key, retrying on collisions.
 * If the key already has an identifier, the existing identifier is reused.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @param {(attempt: number) => NodeIdentifier} makeIdentifier
 * @param {number} [maxAttempts=-1]
 * @returns {NodeIdentifier}
 */
function allocateNodeIdentifier(lookup, nodeKey, makeIdentifier, maxAttempts = -1) {
    const existing = nodeKeyToIdFromLookup(lookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    for (let attempt = 0; maxAttempts < 0 || attempt < maxAttempts; attempt++) {
        const candidate = makeIdentifier(attempt);
        const existingKey = nodeIdToKeyFromLookup(lookup, candidate);
        if (existingKey === undefined) {
            setIdentifierMapping(lookup, candidate, nodeKey);
            return candidate;
        }
    }

    throw new IdentifierAllocationError(nodeKeyStringToString(nodeKey));
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
 * Collision detection checks both the overlay and the base so that newly
 * generated identifiers are guaranteed to be globally unique within this
 * transaction.
 *
 * @param {TransactionIdentifierLookup} txLookup
 * @param {NodeKeyString} nodeKey
 * @param {(attempt: number) => NodeIdentifier} makeIdentifier
 * @param {Set<string> | number} [inFlightIdentifiers]
 * @param {Set<string>} [reservedIdentifiers]
 * @param {number} [maxAttempts=-1]
 * @returns {NodeIdentifier}
 */
function txAllocateNodeIdentifier(
    txLookup,
    nodeKey,
    makeIdentifier,
    inFlightIdentifiers = new Set(),
    reservedIdentifiers = new Set(),
    maxAttempts = -1
) {
    if (typeof inFlightIdentifiers === "number") {
        maxAttempts = inFlightIdentifiers;
        inFlightIdentifiers = new Set();
    }

    const existing = txNodeKeyToId(txLookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    const keyString = nodeKeyStringToString(nodeKey);
    for (let attempt = 0; maxAttempts < 0 || attempt < maxAttempts; attempt++) {
        const candidate = makeIdentifier(attempt);
        const candidateString = nodeIdentifierToString(candidate);
        if (txNodeIdToKey(txLookup, candidate) !== undefined) {
            continue;
        }
        if (inFlightIdentifiers.has(candidateString)) {
            continue;
        }
        inFlightIdentifiers.add(candidateString);
        reservedIdentifiers.add(candidateString);
        txLookup.keyToId.set(keyString, candidate);
        txLookup.idToKey.set(candidateString, nodeKey);
        return candidate;
    }

    throw new IdentifierAllocationError(keyString);
}

/**
 * Serialize the combined (base + overlay) lookup into the sorted-array format
 * used for disk persistence. The overlay entries are appended to the base
 * entries before sorting, so the result reflects all allocations made during
 * this transaction without requiring a separate merge step.
 *
 * Call this **before** `commitTransactionLookup` so that the base is still
 * unmodified while serializing.
 *
 * @param {TransactionIdentifierLookup} txLookup
 * @returns {Array<[NodeIdentifier, NodeKeyString]>}
 */
function serializeTransactionLookup(txLookup) {
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const [idString, nodeKey] of txLookup.base.idToKey.entries()) {
        entries.push([nodeIdentifierFromString(idString), nodeKey]);
    }
    for (const [idString, nodeKey] of txLookup.idToKey.entries()) {
        entries.push([nodeIdentifierFromString(idString), nodeKey]);
    }
    entries.sort(([leftIdentifier], [rightIdentifier]) =>
        compareNodeIdentifier(leftIdentifier, rightIdentifier)
    );
    return entries;
}

/**
 * Apply all overlay entries from a committed transaction to the base lookup
 * in-place. Must be called **only after** a successful disk flush so that the
 * "disk before memory" invariant is preserved.
 *
 * After this call the overlay is exhausted into the base and should not be
 * used again; the transaction object itself is discarded.
 *
 * @param {TransactionIdentifierLookup} txLookup
 * @returns {void}
 */
function commitTransactionLookup(txLookup) {
    for (const [keyString, id] of txLookup.keyToId) {
        txLookup.base.keyToId.set(keyString, id);
    }
    for (const [idString, nodeKey] of txLookup.idToKey) {
        txLookup.base.idToKey.set(idString, nodeKey);
    }
}

module.exports = {
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    mergeIdentifierLookups,
    deleteIdentifierMappingForNodeKey,
    deterministicNodeIdentifierFromNodeKey,
    IdentifierAllocationError,
    IdentifierLookupError,
    IDENTIFIERS_KEY,
    isIdentifierAllocationError,
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
