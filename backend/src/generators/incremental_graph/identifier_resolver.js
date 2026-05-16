/**
 * Identifier resolution helpers for IncrementalGraph runtime operations.
 *
 * This module owns semantic-key ↔ identifier translation inside IncrementalGraph,
 * keeping `graph_storage.js` entirely identifier-native.
 */

const {
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    deterministicNodeIdentifierFromNodeKey,
    makeEmptyIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    nodeIdentifierToString,
    serializeIdentifierLookup,
} = require('./database');

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').GlobalVersionDatabase} GlobalVersionDatabase */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/node_identifier').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */

/** @type {WeakMap<object, IdentifierLookup>} */
const fallbackIdentifierLookups = new WeakMap();

/**
 * Resolve node identifiers for one IncrementalGraph operation.
 * The resolver caches every key/id mapping it touches so each semantic key is
 * translated at most once during the operation.
 * @typedef {object} IdentifierResolver
 * @property {IdentifierLookup} lookup - Mutable lookup snapshot for the current operation.
 * @property {(nodeKey: NodeKeyString) => NodeIdentifier | undefined} lookupNodeIdentifier - Read an existing identifier without allocating a new one.
 * @property {(nodeKey: NodeKeyString) => NodeIdentifier} getOrAllocateNodeIdentifier - Read an existing identifier or allocate one for the current operation.
 * @property {(nodeIdentifier: NodeIdentifier) => NodeKeyString} requireNodeKey - Convert an identifier back to its semantic node key.
 * @property {(batch: BatchBuilder, globalDatabase?: GlobalVersionDatabase) => void} queueLookupPersistence - Append the lookup write to the current batch when allocations happened.
 * @property {(rootDatabase: RootDatabase) => void} commitPersistedLookup - Publish the committed lookup snapshot back into the open RootDatabase.
 */

/**
 * Get the active identifier lookup for the current root database implementation.
 * Compatibility test doubles do not implement the identifier-lookup API, so they
 * fall back to a hidden in-memory lookup owned by the test database instance.
 * @param {RootDatabase} rootDatabase
 * @returns {IdentifierLookup}
 */
function getActiveLookup(rootDatabase) {
    if (typeof rootDatabase.cloneActiveIdentifierLookup === "function") {
        return rootDatabase.cloneActiveIdentifierLookup();
    }
    const cachedLookup = fallbackIdentifierLookups.get(rootDatabase);
    if (cachedLookup !== undefined) {
        return cloneIdentifierLookup(cachedLookup);
    }
    const emptyLookup = makeEmptyIdentifierLookup();
    fallbackIdentifierLookups.set(rootDatabase, emptyLookup);
    return cloneIdentifierLookup(emptyLookup);
}

/**
 * Allocate a new identifier for a semantic node key.
 * Compatibility test doubles fall back to deterministic identifiers derived from the key.
 * @param {RootDatabase} rootDatabase
 * @param {IdentifierLookup} lookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function allocateIdentifier(rootDatabase, lookup, nodeKey) {
    return allocateNodeIdentifier(lookup, nodeKey, () => {
        if (typeof rootDatabase.generateNodeIdentifier === "function") {
            return rootDatabase.generateNodeIdentifier();
        }
        return deterministicNodeIdentifierFromNodeKey(nodeKey);
    });
}

/**
 * Create a per-operation identifier resolver.
 * @param {RootDatabase} rootDatabase
 * @returns {IdentifierResolver}
 */
function makeIdentifierResolver(rootDatabase) {
    const lookup = cloneIdentifierLookup(getActiveLookup(rootDatabase));
    /** @type {Map<string, NodeIdentifier>} */
    const identifiersByNodeKey = new Map();
    /** @type {Map<string, NodeKeyString>} */
    const nodeKeysByIdentifier = new Map();
    let hasPendingLookupWrite = false;

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
        const nodeIdentifier = nodeKeyToIdFromLookup(lookup, nodeKey);
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
        return cacheMapping(
            nodeKey,
            allocateIdentifier(rootDatabase, lookup, nodeKey)
        );
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
        const nodeKey = nodeIdToKeyFromLookup(lookup, nodeIdentifier);
        if (nodeKey === undefined) {
            throw new Error(`Missing semantic node key for identifier ${identifierString}`);
        }
        cacheMapping(nodeKey, nodeIdentifier);
        return nodeKey;
    }

    return {
        lookup,
        lookupNodeIdentifier,
        getOrAllocateNodeIdentifier,
        requireNodeKey,
        queueLookupPersistence(batch, globalDatabase) {
            if (!hasPendingLookupWrite || globalDatabase === undefined) {
                return;
            }
            batch.appendOperation(
                globalDatabase.rawPutOp(IDENTIFIERS_KEY, serializeIdentifierLookup(lookup))
            );
        },
        commitPersistedLookup(rootDatabaseToUpdate) {
            if (!hasPendingLookupWrite) {
                return;
            }
            if (typeof rootDatabaseToUpdate.replaceActiveIdentifierLookup === "function") {
                rootDatabaseToUpdate.replaceActiveIdentifierLookup(lookup);
            } else {
                fallbackIdentifierLookups.set(
                    rootDatabaseToUpdate,
                    cloneIdentifierLookup(lookup)
                );
            }
            hasPendingLookupWrite = false;
        },
    };
}

module.exports = {
    makeIdentifierResolver,
};
