const crypto = require("crypto");

const {
    compareNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("./node_identifier");
const {
    nodeKeyStringToString,
} = require("./types");

/** @typedef {import("./node_identifier").NodeIdentifier} NodeIdentifier */
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
 * @typedef {object} IdentifierLookup
 * @property {Map<string, NodeIdentifier>} keyToId - Semantic node key string -> opaque identifier.
 * @property {Map<string, NodeKeyString>} idToKey - Opaque identifier string -> semantic node key.
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
    cloneIdentifierLookup,
    deleteIdentifierMappingForNodeKey,
    deterministicNodeIdentifierFromNodeKey,
    IdentifierAllocationError,
    IdentifierLookupError,
    IDENTIFIERS_KEY,
    isIdentifierAllocationError,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
};
