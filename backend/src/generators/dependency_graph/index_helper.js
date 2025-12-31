/**
 * Index helper for persistent reverse-dependency tracking.
 * Provides methods to store and query reverse dependencies and node inputs.
 */

/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */

/**
 * Union type for values that can be stored in the database.
 * @typedef {DatabaseValue | Freshness} DatabaseStoredValue
 */

/**
 * Helper to create a put operation for batch processing.
 * @private
 * @param {string} key
 * @param {DatabaseStoredValue} value
 * @returns {{ type: "put", key: string, value: DatabaseStoredValue }}
 */
function putOp(key, value) {
    return { type: "put", key, value };
}

/**
 * @typedef {object} Index
 * @property {(node: string) => string} inputsKey - Get the DB key for storing a node's inputs
 * @property {(input: string) => string} revdepPrefix - Get the DB key prefix for querying dependents of an input
 * @property {(node: string, inputs: string[], batchOps: Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>) => Promise<void>} ensureNodeIndexed - Ensure node's inputs and reverse deps are indexed
 * @property {(input: string) => Promise<string[]>} listDependents - List all nodes that depend on the given input
 * @property {(node: string) => Promise<string[] | null>} getInputs - Get the inputs for a node
 */

/**
 * Creates an index helper for managing persistent reverse dependencies.
 * 
 * @param {Database} database - The database instance
 * @param {string} schemaHash - The schema hash for namespacing
 * @returns {Index}
 */
function makeIndex(database, schemaHash) {
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

    /**
     * Ensure a node's inputs and reverse dependencies are indexed in the database.
     * This adds the necessary put operations to the batch array.
     * 
     * @param {string} node - Canonical node key
     * @param {string[]} inputs - Array of canonical input keys
     * @param {Array<{type: "put", key: string, value: DatabaseStoredValue} | {type: "del", key: string}>} batchOps - Batch operations array to append to
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
        // We store inputs as a JSON-serialized array wrapped in an object
        // to satisfy DatabaseValue constraint (must be an object)
        batchOps.push(
            putOp(
                inputsKey(node),
                /** @type {DatabaseValue} */ (/** @type {unknown} */ ({ inputs }))
            )
        );

        // Store reverse dependency edges
        for (const input of inputs) {
            batchOps.push(
                putOp(
                    revdepKey(input, node),
                    /** @type {DatabaseValue} */ (/** @type {unknown} */ ({ __edge: true }))
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

        // Extract inputs array from the stored object
        // We stored it as { inputs: string[] }
        if (typeof value === "object" && value !== null && "inputs" in value) {
            const inputs = value.inputs;
            if (Array.isArray(inputs)) {
                return inputs;
            }
        }

        // Unexpected format - return null to be safe
        return null;
    }

    return {
        inputsKey,
        revdepPrefix,
        ensureNodeIndexed,
        listDependents,
        getInputs,
    };
}

/**
 * Type guard for Index.
 * @param {unknown} object
 * @returns {object is Index}
 */
function isIndex(object) {
    return (
        typeof object === "object" &&
        object !== null &&
        "inputsKey" in object &&
        "revdepPrefix" in object &&
        "ensureNodeIndexed" in object &&
        "listDependents" in object &&
        "getInputs" in object
    );
}

module.exports = {
    makeIndex,
    isIndex,
};
