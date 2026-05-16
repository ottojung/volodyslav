const crypto = require("crypto");

const {
    compareNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("./node_identifier");
const {
    nodeKeyStringToString,
    stringToNodeKeyString,
} = require("./types");

const IDENTIFIERS_KEY = "identifiers_keys_map";

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
 * @property {Map<string, import('./node_identifier').NodeIdentifier>} keyToId
 * @property {Map<string, import('./types').NodeKeyString>} idToKey
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
 * @param {Array<[import('./node_identifier').NodeIdentifier, import('./types').NodeKeyString]>} entries
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
 * @param {IdentifierLookup} lookup
 * @returns {IdentifierLookup}
 */
function cloneIdentifierLookup(lookup) {
    return makeIdentifierLookup(serializeIdentifierLookup(lookup));
}

/**
 * @param {IdentifierLookup} lookup
 * @returns {Array<[import('./node_identifier').NodeIdentifier, import('./types').NodeKeyString]>}
 */
function serializeIdentifierLookup(lookup) {
    /** @type {Array<[import('./node_identifier').NodeIdentifier, import('./types').NodeKeyString]>} */
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
 * @param {IdentifierLookup} lookup
 * @param {import('./types').NodeKeyString} nodeKey
 * @returns {import('./node_identifier').NodeIdentifier | undefined}
 */
function nodeKeyToIdFromLookup(lookup, nodeKey) {
    return lookup.keyToId.get(nodeKeyStringToString(nodeKey));
}

/**
 * @param {IdentifierLookup} lookup
 * @param {import('./node_identifier').NodeIdentifier} nodeIdentifier
 * @returns {import('./types').NodeKeyString | undefined}
 */
function nodeIdToKeyFromLookup(lookup, nodeIdentifier) {
    return lookup.idToKey.get(nodeIdentifierToString(nodeIdentifier));
}

/**
 * @param {IdentifierLookup} lookup
 * @param {import('./node_identifier').NodeIdentifier} nodeIdentifier
 * @param {import('./types').NodeKeyString} nodeKey
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
 * @param {IdentifierLookup} lookup
 * @param {import('./types').NodeKeyString} nodeKey
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
 * @param {import('./types').NodeKeyString} nodeKey
 * @param {number} attempt
 * @returns {import('./node_identifier').NodeIdentifier}
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
 * @param {IdentifierLookup} lookup
 * @param {import('./types').NodeKeyString} nodeKey
 * @param {(attempt: number) => import('./node_identifier').NodeIdentifier} makeIdentifier
 * @param {number} [maxAttempts=64]
 * @returns {import('./node_identifier').NodeIdentifier}
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
 * @param {IdentifierLookup} lookup
 * @param {import('./node_identifier').NodeIdentifier} nodeIdentifier
 * @returns {import('./types').NodeKeyString}
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
 * @param {IdentifierLookup} lookup
 * @param {import('./types').NodeKeyString} nodeKey
 * @returns {import('./node_identifier').NodeIdentifier}
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
    stringToNodeKeyString,
};
