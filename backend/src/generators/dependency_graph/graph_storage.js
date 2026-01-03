/**
 * GraphStorage module.
 * Encapsulates database access for the dependency graph, handling key generation and type safety.
 */

const { freshnessKey } = require("../database");

/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */
/** @typedef {import('../database/types').DatabaseBatchOperation} DatabaseBatchOperation */

/**
 * Internal storage type for node inputs metadata
 * @typedef {object} NodeInputsMetadata
 * @property {string[]} inputs - Array of input node names
 */

/**
 * Internal storage type for reverse dependency edge markers
 * @typedef {object} RevDepEdgeMarker
 * @property {true} __edge - Marker to indicate this is an edge entry
 */

/**
 * Union type for all values that can be stored in the database.
 * Includes both user data (DatabaseValue) and internal metadata.
 * @typedef {DatabaseValue | Freshness | NodeInputsMetadata | RevDepEdgeMarker} DatabaseStoredValue
 */

/**
 * A database put operation for graph storage with extended value types.
 * @typedef {object} GraphStoragePutOperation
 * @property {'put'} type - Operation type
 * @property {string} key - The key to store
 * @property {DatabaseStoredValue} value - The value to store
 */

/**
 * A database delete operation.
 * @typedef {object} GraphStorageDelOperation
 * @property {'del'} type - Operation type
 * @property {string} key - The key to delete
 */

/**
 * A batch operation for graph storage.
 * @typedef {GraphStoragePutOperation | GraphStorageDelOperation} GraphStorageBatchOperation
 */

/**
 * @typedef {object} GraphStorage
 * @property {(nodeName: string) => Promise<DatabaseValue | undefined>} getNodeValue
 * @property {(nodeName: string) => Promise<Freshness | undefined>} getNodeFreshness
 * @property {(nodeName: string, value: DatabaseValue) => DatabaseBatchOperation} setNodeValueOp
 * @property {(nodeName: string, freshness: Freshness) => DatabaseBatchOperation} setNodeFreshnessOp
 * @property {(node: string, inputs: string[], batchOps: Array<any>) => Promise<void>} ensureNodeIndexed
 * @property {(input: string) => Promise<string[]>} listDependents
 * @property {(node: string) => Promise<string[] | null>} getInputs
 * @property {() => Promise<string[]>} listAllKeys
 * @property {(key: string) => Promise<DatabaseStoredValue | undefined>} getRaw
 * @property {() => Promise<string[]>} listMaterializedNodes
 */

/**
 * Creates a GraphStorage instance.
 * 
 * @param {Database} database - The database instance
 * @param {string} schemaHash - The schema hash for namespacing
 * @returns {GraphStorage}
 */
function makeGraphStorage(database, schemaHash) {
    /**
     * Helper to create a put operation for batch processing.
     * @private
     * @param {string} key
     * @param {any} value
     * @returns {any}
     */
    function putOp(key, value) {
        return { type: "put", key, value };
    }

    // --- Key Generation ---

    /**
     * Get the DB key for storing a node's inputs.
     * Format: dg:<schemaHash>:inputs:<NODE>
     * @param {string} node - Canonical node key
     * @returns {string}
     */
    function inputsKey(node) {
        return `dg:${schemaHash}:inputs:${node}`;
    }

    /**
     * Get the DB key prefix for querying dependents of an input.
     * Format: dg:<schemaHash>:revdep:<INPUT>:
     * @param {string} input - Canonical input key
     * @returns {string}
     */
    function revdepPrefix(input) {
        return `dg:${schemaHash}:revdep:${input}:`;
    }

    /**
     * Get the DB key for a specific reverse dependency edge.
     * Format: dg:<schemaHash>:revdep:<INPUT>:<NODE>
     * @param {string} input - Canonical input key
     * @param {string} node - Canonical dependent node key
     * @returns {string}
     */
    function revdepKey(input, node) {
        return `dg:${schemaHash}:revdep:${input}:${node}`;
    }

    // --- Value & Freshness Access ---

    /**
     * Get a node's value.
     * @param {string} nodeName
     * @returns {Promise<DatabaseValue | undefined>}
     */
    async function getNodeValue(nodeName) {
        return database.getValue(nodeName);
    }

    /**
     * Get a node's freshness.
     * @param {string} nodeName
     * @returns {Promise<Freshness | undefined>}
     */
    async function getNodeFreshness(nodeName) {
        return database.getFreshness(freshnessKey(nodeName));
    }

    /**
     * Create an operation to set a node's value.
     * @param {string} nodeName
     * @param {DatabaseValue} value
     * @returns {DatabaseBatchOperation}
     */
    function setNodeValueOp(nodeName, value) {
        return putOp(nodeName, value);
    }

    /**
     * Create an operation to set a node's freshness.
     * @param {string} nodeName
     * @param {Freshness} freshness
     * @returns {DatabaseBatchOperation}
     */
    function setNodeFreshnessOp(nodeName, freshness) {
        return putOp(freshnessKey(nodeName), freshness);
    }

    // --- Indexing ---

    /**
     * Ensure a node's inputs and reverse dependencies are indexed in the database.
     * This adds the necessary put operations to the batch array.
     * 
     * @param {string} node - Canonical node key
     * @param {string[]} inputs - Array of canonical input keys
     * @param {Array<any>} batchOps - Batch operations array to append to
     * @returns {Promise<void>}
     */
    async function ensureNodeIndexed(node, inputs, batchOps) {
        // Check if inputs are already indexed (optimization to avoid redundant writes)
        const existingInputs = await getInputs(node);
        if (existingInputs !== null) {
            // Already indexed, skip
            return;
        }

        // Store the inputs list for this node
        // We store inputs as { inputs: string[] }
        /** @type {NodeInputsMetadata} */
        const inputsMetadata = { inputs };
        batchOps.push(
            putOp(
                inputsKey(node),
                inputsMetadata
            )
        );

        // Store reverse dependency edges
        for (const input of inputs) {
            /** @type {RevDepEdgeMarker} */
            const edgeMarker = { __edge: true };
            batchOps.push(
                putOp(
                    revdepKey(input, node),
                    edgeMarker
                )
            );
        }
    }

    /**
     * List all nodes that depend on the given input.
     * Queries the database for all keys with the revdep prefix.
     * 
     * @param {string} input - Canonical input key
     * @returns {Promise<string[]>} Array of dependent node keys
     */
    async function listDependents(input) {
        const prefix = revdepPrefix(input);
        const keys = await database.keys(prefix);
        
        // Extract node names from keys
        // Key format: dg:<schemaHash>:revdep:<INPUT>:<NODE>
        // We need to extract <NODE> which is everything after the prefix
        const dependents = keys.map((key) => {
            return key.substring(prefix.length);
        });

        return dependents;
    }

    /**
     * Get the inputs for a node from the database.
     * Returns null if the node hasn't been indexed yet.
     * 
     * @param {string} node - Canonical node key
     * @returns {Promise<string[] | null>} Array of input keys, or null if not indexed
     */
    async function getInputs(node) {
        const key = inputsKey(node);
        const value = await database.get(key);
        
        if (value === undefined) {
            return null;
        }

        // Extract inputs array from the stored metadata object
        // We stored it as NodeInputsMetadata: { inputs: string[] }
        if (typeof value === "object" && value !== null && "inputs" in value) {
            const metadata = value;
            if ("inputs" in metadata && Array.isArray(metadata.inputs)) {
                return metadata.inputs;
            }
        }

        // Unexpected format - return null to be safe
        return null;
    }

    /**
     * List all keys in the database.
     * @returns {Promise<string[]>}
     */
    async function listAllKeys() {
        return database.keys();
    }

    /**
     * Get raw value from database.
     * @param {string} key
     * @returns {Promise<DatabaseStoredValue | undefined>}
     */
    async function getRaw(key) {
        return database.get(key);
    }

    /**
     * List all materialized nodes.
     * @returns {Promise<string[]>}
     */
    async function listMaterializedNodes() {
        const allKeys = await database.keys();
        return allKeys.filter(k => 
            !k.startsWith("dg:") && 
            !k.startsWith("freshness:")
        );
    }

    return {
        getNodeValue,
        getNodeFreshness,
        setNodeValueOp,
        setNodeFreshnessOp,
        ensureNodeIndexed,
        listDependents,
        getInputs,
        listAllKeys,
        getRaw,
        listMaterializedNodes,
    };
}

module.exports = {
    makeGraphStorage,
};
