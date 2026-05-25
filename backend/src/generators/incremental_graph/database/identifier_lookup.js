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
 * Private state container for IdentifierLookup instances.
 * Using a WeakMap ensures that external code cannot access the raw Maps —
 * the only way to read or mutate an IdentifierLookup is through the provided functions.
 * Cloning is intentionally not supported; use serializeIdentifierLookup to export data.
 *
 * @type {WeakMap<IdentifierLookupClass, {keyToId: Map<string, NodeIdentifier>, idToKey: Map<string, NodeKeyString>}>}
 */
const lookupState = new WeakMap();

/**
 * Opaque bijection between NodeKeyString and NodeIdentifier.
 * Do NOT store or clone this object directly — it is mutated in-place under the graph mutex.
 * Use the provided functions (nodeKeyToIdFromLookup, nodeIdToKeyFromLookup, etc.) to interact with it.
 */
class IdentifierLookupClass {
    /** @type {undefined} */
    __brand = undefined;

    constructor() {
        lookupState.set(this, {
            keyToId: new Map(),
            idToKey: new Map(),
        });
        if (this.__brand !== undefined) {
            throw new Error("IdentifierLookup is a nominal type");
        }
    }
}

/**
 * @typedef {IdentifierLookupClass} IdentifierLookup
 */

/**
 * Internal accessor for the private Maps of an IdentifierLookup.
 * Only available within this module.
 * @param {IdentifierLookup} lookup
 * @returns {{keyToId: Map<string, NodeIdentifier>, idToKey: Map<string, NodeKeyString>}}
 */
function getState(lookup) {
    const state = lookupState.get(lookup);
    if (state === undefined) {
        throw new IdentifierLookupError("Not a valid IdentifierLookup instance");
    }
    return state;
}

/**
 * Create an empty IdentifierLookup with no entries.
 * @returns {IdentifierLookup}
 */
function makeEmptyIdentifierLookup() {
    return new IdentifierLookupClass();
}

/**
 * Build a validated in-memory lookup from persisted `[id, key]` entries.
 * The input must already be a strict bijection.
 * @param {Array<[NodeIdentifier, NodeKeyString]>} entries
 * @returns {IdentifierLookup}
 */
function makeIdentifierLookup(entries) {
    const lookup = makeEmptyIdentifierLookup();
    const state = getState(lookup);
    for (const [nodeIdentifier, nodeKey] of entries) {
        const identifierString = nodeIdentifierToString(nodeIdentifier);
        const nodeKeyString = nodeKeyStringToString(nodeKey);
        if (state.idToKey.has(identifierString)) {
            throw new IdentifierLookupError(`Duplicate node identifier in lookup map: ${identifierString}`);
        }
        if (state.keyToId.has(nodeKeyString)) {
            throw new IdentifierLookupError(`Duplicate node key in lookup map: ${nodeKeyString}`);
        }
        state.idToKey.set(identifierString, nodeKey);
        state.keyToId.set(nodeKeyString, nodeIdentifier);
    }
    return lookup;
}

/**
 * Convert the lookup back into its persisted form, sorted by identifier string.
 * This is also used to iterate all entries — the returned array is the only
 * way to enumerate an IdentifierLookup's contents from outside this module.
 * @param {IdentifierLookup} lookup
 * @returns {Array<[NodeIdentifier, NodeKeyString]>}
 */
function serializeIdentifierLookup(lookup) {
    const { idToKey } = getState(lookup);
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const [identifierString, nodeKey] of idToKey.entries()) {
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
 * Returns undefined if the key is not in the lookup.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function nodeKeyToIdFromLookup(lookup, nodeKey) {
    return getState(lookup).keyToId.get(nodeKeyStringToString(nodeKey));
}

/**
 * Read the semantic node key currently assigned to an identifier.
 * Returns undefined if the identifier is not in the lookup.
 * @param {IdentifierLookup} lookup
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString | undefined}
 */
function nodeIdToKeyFromLookup(lookup, nodeIdentifier) {
    return getState(lookup).idToKey.get(nodeIdentifierToString(nodeIdentifier));
}

/**
 * Return the number of (identifier, key) pairs in the lookup.
 * @param {IdentifierLookup} lookup
 * @returns {number}
 */
function getIdentifierLookupSize(lookup) {
    return getState(lookup).idToKey.size;
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
    const state = getState(lookup);
    const identifierString = nodeIdentifierToString(nodeIdentifier);
    const nodeKeyString = nodeKeyStringToString(nodeKey);
    const existingKey = state.idToKey.get(identifierString);
    if (existingKey !== undefined && existingKey !== nodeKey) {
        throw new IdentifierLookupError(
            `Node identifier ${identifierString} is already assigned to ${nodeKeyStringToString(existingKey)}`
        );
    }
    const existingIdentifier = state.keyToId.get(nodeKeyString);
    if (existingIdentifier !== undefined && existingIdentifier !== nodeIdentifier) {
        throw new IdentifierLookupError(
            `Node key ${nodeKeyString} is already assigned to ${nodeIdentifierToString(existingIdentifier)}`
        );
    }
    state.idToKey.set(identifierString, nodeKey);
    state.keyToId.set(nodeKeyString, nodeIdentifier);
}

/**
 * Remove the mapping for a semantic node key if one exists.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @returns {void}
 */
function deleteIdentifierMappingForNodeKey(lookup, nodeKey) {
    const state = getState(lookup);
    const nodeKeyString = nodeKeyStringToString(nodeKey);
    const existingIdentifier = state.keyToId.get(nodeKeyString);
    if (existingIdentifier === undefined) {
        return;
    }
    state.keyToId.delete(nodeKeyString);
    state.idToKey.delete(nodeIdentifierToString(existingIdentifier));
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
 * Create a new lookup containing all entries from both `base` and `overlay`.
 * Conflicting assignments (same identifier or key mapped to different counterparts)
 * throw `IdentifierLookupError`.
 *
 * Neither the base nor the overlay is modified; a new IdentifierLookup is returned.
 * Used only during migration sync — not in the hot transaction path.
 * @param {IdentifierLookup} base
 * @param {IdentifierLookup} overlay
 * @returns {IdentifierLookup}
 */
function mergeIdentifierLookups(base, overlay) {
    const merged = makeIdentifierLookup(serializeIdentifierLookup(base));
    for (const [overlayId, overlayKey] of serializeIdentifierLookup(overlay)) {
        setIdentifierMapping(merged, overlayId, overlayKey);
    }
    return merged;
}

/**
 * Merge all entries from `overlay` into `base` in-place.
 * Used at transaction commit time to incorporate pending allocations into the
 * committed lookup without creating a new object.
 * Conflicting assignments throw `IdentifierLookupError`.
 * @param {IdentifierLookup} base
 * @param {IdentifierLookup} overlay
 * @returns {void}
 */
function mergeIdentifierLookupInto(base, overlay) {
    for (const [overlayId, overlayKey] of serializeIdentifierLookup(overlay)) {
        setIdentifierMapping(base, overlayId, overlayKey);
    }
}

/**
 * Allocate a fresh identifier for a node key, retrying on collisions.
 * If the key already has an identifier, the existing identifier is reused.
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @param {(attempt: number) => NodeIdentifier} makeIdentifier
 * @param {number} [maxAttempts=64]
 * @returns {NodeIdentifier}
 */
function allocateNodeIdentifier(lookup, nodeKey, makeIdentifier, maxAttempts = 64) {
    const existing = nodeKeyToIdFromLookup(lookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
 * Allocate a fresh identifier for a node key, checking both a committed lookup
 * and a pending-allocations overlay for collisions.
 * The new entry is added only to `pendingAllocations`, not to `committedLookup`.
 * The key must not already be present in either lookup when this function is called.
 * @param {IdentifierLookup} committedLookup - Committed state (read-only in this call).
 * @param {IdentifierLookup} pendingAllocations - Overlay for this transaction (mutated).
 * @param {NodeKeyString} nodeKey
 * @param {(attempt: number) => NodeIdentifier} makeIdentifier
 * @param {number} [maxAttempts=64]
 * @returns {NodeIdentifier}
 */
function allocateNodeIdentifierWithOverlay(
    committedLookup,
    pendingAllocations,
    nodeKey,
    makeIdentifier,
    maxAttempts = 64
) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = makeIdentifier(attempt);
        // The candidate must not be used in either the committed state or the pending overlay.
        if (
            nodeIdToKeyFromLookup(committedLookup, candidate) === undefined &&
            nodeIdToKeyFromLookup(pendingAllocations, candidate) === undefined
        ) {
            setIdentifierMapping(pendingAllocations, candidate, nodeKey);
            return candidate;
        }
    }
    throw new IdentifierAllocationError(nodeKeyStringToString(nodeKey));
}

/**
 * Produce the persisted form of the committed lookup combined with pending allocations,
 * without merging them into a single IdentifierLookup object.
 * The result is a sorted array of [NodeIdentifier, NodeKeyString] pairs covering
 * all entries from both inputs, ready to be written to disk.
 * @param {IdentifierLookup} committedLookup
 * @param {IdentifierLookup} pendingAllocations
 * @returns {Array<[NodeIdentifier, NodeKeyString]>}
 */
function serializeIdentifierLookupWithPending(committedLookup, pendingAllocations) {
    const committedEntries = serializeIdentifierLookup(committedLookup);
    const pendingEntries = serializeIdentifierLookup(pendingAllocations);
    const combined = [...committedEntries, ...pendingEntries];
    combined.sort(([leftId], [rightId]) => compareNodeIdentifier(leftId, rightId));
    return combined;
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

module.exports = {
    allocateNodeIdentifier,
    allocateNodeIdentifierWithOverlay,
    mergeIdentifierLookups,
    mergeIdentifierLookupInto,
    deleteIdentifierMappingForNodeKey,
    deterministicNodeIdentifierFromNodeKey,
    IdentifierAllocationError,
    IdentifierLookupError,
    IDENTIFIERS_KEY,
    getIdentifierLookupSize,
    isIdentifierAllocationError,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    serializeIdentifierLookupWithPending,
    setIdentifierMapping,
};
