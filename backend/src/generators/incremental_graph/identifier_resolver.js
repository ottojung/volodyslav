/**
 * Identifier resolution helpers for IncrementalGraph runtime operations.
 *
 * This module owns semantic-key ↔ identifier translation inside IncrementalGraph,
 * keeping `graph_storage.js` entirely identifier-native.
 */

const {
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    deterministicNodeIdentifierFromNodeKey,
    makeEmptyIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    nodeIdentifierToString,
    setIdentifierMapping,
} = require('./database');

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */

/** @type {WeakMap<object, IdentifierLookup>} */
const fallbackIdentifierLookups = new WeakMap();

/**
 * Get the active identifier lookup for the current root database implementation.
 * Real RootDatabase instances expose cloneActiveIdentifierLookup(); test doubles
 * that don't implement this API fall back to a per-instance in-memory lookup.
 * @param {RootDatabase} rootDatabase
 * @returns {IdentifierLookup}
 */
function getActiveLookup(rootDatabase) {
    if (typeof rootDatabase.cloneActiveIdentifierLookup === "function") {
        return rootDatabase.cloneActiveIdentifierLookup();
    }
    const cached = fallbackIdentifierLookups.get(rootDatabase);
    if (cached !== undefined) {
        return cloneIdentifierLookup(cached);
    }
    const empty = makeEmptyIdentifierLookup();
    const clonedEmpty = cloneIdentifierLookup(empty);
    fallbackIdentifierLookups.set(rootDatabase, clonedEmpty);
    return cloneIdentifierLookup(clonedEmpty);
}

/**
 * Replace the active identifier lookup for the given root database.
 * @param {RootDatabase} rootDatabase
 * @param {IdentifierLookup} lookup
 * @returns {void}
 */
function setActiveLookup(rootDatabase, lookup) {
    if (typeof rootDatabase.replaceActiveIdentifierLookup === "function") {
        rootDatabase.replaceActiveIdentifierLookup(lookup);
    } else {
        fallbackIdentifierLookups.set(rootDatabase, lookup);
    }
}

/**
 * Resolve node identifiers for one IncrementalGraph operation.
 * The resolver caches every key/id mapping it touches so each semantic key is
 * translated at most once during the operation.
 * @typedef {object} IdentifierResolver
 * @property {IdentifierLookup} lookup - Mutable lookup snapshot for the current operation.
 * @property {(nodeKey: NodeKeyString) => NodeIdentifier | undefined} lookupNodeIdentifier - Read an existing identifier without allocating a new one.
 * @property {(nodeKey: NodeKeyString) => NodeIdentifier} getOrAllocateNodeIdentifier - Read an existing identifier or allocate one for the current operation.
 * @property {(nodeIdentifier: NodeIdentifier) => NodeKeyString} requireNodeKey - Convert an identifier back to its semantic node key.
 * @property {boolean} hasPendingAllocations - True if this resolver has allocated at least one new identifier that has not yet been committed to the database.
 * @property {(activeLookup: IdentifierLookup) => void} applyPendingTo - Merge all pending identifier allocations into the given lookup (mutates it in place).
 */

/**
 * Create a per-operation identifier resolver.
 * @param {RootDatabase} rootDatabase
 * @returns {IdentifierResolver}
 */
function makeIdentifierResolver(rootDatabase) {
    /** @type {IdentifierLookup | null} */
    let lookup = null;
    /** @type {Map<string, NodeIdentifier>} */
    const identifiersByNodeKey = new Map();
    /** @type {Map<string, NodeKeyString>} */
    const nodeKeysByIdentifier = new Map();
    let hasPendingLookupWrite = false;
    /** @type {Map<string, { nodeKey: NodeKeyString, nodeIdentifier: NodeIdentifier }>} */
    const pendingIdentifierMappings = new Map();

    /**
     * @returns {IdentifierLookup}
     */
    function ensureLookup() {
        if (lookup === null) {
            lookup = getActiveLookup(rootDatabase);
        }
        return lookup;
    }

    /**
     * @param {NodeKeyString} nodeKey
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {NodeIdentifier}
     */
    function cacheMapping(nodeKey, nodeIdentifier) {
        identifiersByNodeKey.set(String(nodeKey), nodeIdentifier);
        nodeKeysByIdentifier.set(nodeIdentifierToString(nodeIdentifier), nodeKey);
        return nodeIdentifier;
    }

    /**
     * @param {NodeKeyString} nodeKey
     * @returns {NodeIdentifier | undefined}
     */
    function lookupNodeIdentifier(nodeKey) {
        const cached = identifiersByNodeKey.get(String(nodeKey));
        if (cached !== undefined) {
            return cached;
        }
        const nodeIdentifier = nodeKeyToIdFromLookup(ensureLookup(), nodeKey);
        if (nodeIdentifier === undefined) {
            return undefined;
        }
        return cacheMapping(nodeKey, nodeIdentifier);
    }

    /**
     * @param {NodeKeyString} nodeKey
     * @returns {NodeIdentifier}
     */
    function getOrAllocateNodeIdentifier(nodeKey) {
        const existing = lookupNodeIdentifier(nodeKey);
        if (existing !== undefined) {
            return existing;
        }
        hasPendingLookupWrite = true;
        const nodeIdentifier = cacheMapping(
            nodeKey,
            allocateNodeIdentifier(ensureLookup(), nodeKey, (attempt) => {
                if (typeof rootDatabase.generateNodeIdentifier === "function") {
                    return rootDatabase.generateNodeIdentifier();
                }
                return deterministicNodeIdentifierFromNodeKey(nodeKey, attempt);
            })
        );
        pendingIdentifierMappings.set(String(nodeKey), { nodeKey, nodeIdentifier });
        return nodeIdentifier;
    }

    /**
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {NodeKeyString}
     */
    function requireNodeKey(nodeIdentifier) {
        const identifierString = nodeIdentifierToString(nodeIdentifier);
        const cached = nodeKeysByIdentifier.get(identifierString);
        if (cached !== undefined) {
            return cached;
        }
        const nodeKey = nodeIdToKeyFromLookup(ensureLookup(), nodeIdentifier);
        if (nodeKey === undefined) {
            throw new Error(`Missing semantic node key for identifier ${identifierString}`);
        }
        cacheMapping(nodeKey, nodeIdentifier);
        return nodeKey;
    }

    return {
        get lookup() {
            return ensureLookup();
        },
        lookupNodeIdentifier,
        getOrAllocateNodeIdentifier,
        requireNodeKey,
        get hasPendingAllocations() {
            return hasPendingLookupWrite;
        },
        applyPendingTo(activeLookup) {
            for (const { nodeKey, nodeIdentifier } of pendingIdentifierMappings.values()) {
                setIdentifierMapping(activeLookup, nodeIdentifier, nodeKey);
            }
        },
    };
}

module.exports = {
    makeIdentifierResolver,
    getActiveLookup,
    setActiveLookup,
};
