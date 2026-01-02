/**
 * GraphStorage module.
 * Encapsulates database access for the dependency graph using sublevel-based storage.
 */

const { getSchemaStorage } = require("../database");

/** @typedef {import('../database/class').Database} Database */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */
/** @typedef {import('../database/batch_types').GenericBatchOp} GenericBatchOp */
/** @typedef {import('../database/batch_types').InputsRecord} InputsRecord */

/**
 * @typedef {object} GraphStorage
 * @property {(nodeName: string) => Promise<DatabaseValue | undefined>} getNodeValue
 * @property {(nodeName: string) => Promise<Freshness | undefined>} getNodeFreshness
 * @property {(nodeName: string, value: DatabaseValue) => GenericBatchOp} setNodeValueOp
 * @property {(nodeName: string, freshness: Freshness) => GenericBatchOp} setNodeFreshnessOp
 * @property {(node: string, inputs: string[], batchOps: Array<GenericBatchOp>) => Promise<void>} ensureNodeIndexed
 * @property {(input: string) => Promise<string[]>} listDependents
 * @property {(node: string) => Promise<string[] | null>} getInputs
 * @property {() => Promise<string[]>} listMaterializedNodes
 */

/**
 * Creates a GraphStorage instance using sublevel-based storage.
 * 
 * @param {Database} database - The database instance with sublevels
 * @param {string} schemaHash - The schema hash for namespacing
 * @returns {GraphStorage}
 */
function makeGraphStorage(database, schemaHash) {
    // Get schema storage for this graph's schema
    const schemaStorage = getSchemaStorage(database.schemas, schemaHash);

    // --- Value & Freshness Access ---

    /**
     * Get a node's value from the values sublevel.
     * @param {string} nodeName
     * @returns {Promise<DatabaseValue | undefined>}
     */
    async function getNodeValue(nodeName) {
        try {
            return await database.values.get(nodeName);
        } catch (err) {
            // Level throws for missing keys, return undefined
            return undefined;
        }
    }

    /**
     * Get a node's freshness from the freshness sublevel.
     * @param {string} nodeName
     * @returns {Promise<Freshness | undefined>}
     */
    async function getNodeFreshness(nodeName) {
        try {
            return await database.freshness.get(nodeName);
        } catch (err) {
            // Level throws for missing keys, return undefined
            return undefined;
        }
    }

    /**
     * Create an operation to set a node's value in the values sublevel.
     * @param {string} nodeName
     * @param {DatabaseValue} value
     * @returns {GenericBatchOp}
     */
    function setNodeValueOp(nodeName, value) {
        return { type: "put", sublevel: "values", key: nodeName, value };
    }

    /**
     * Create an operation to set a node's freshness in the freshness sublevel.
     * @param {string} nodeName
     * @param {Freshness} freshness
     * @returns {GenericBatchOp}
     */
    function setNodeFreshnessOp(nodeName, freshness) {
        return { type: "put", sublevel: "freshness", key: nodeName, value: freshness };
    }

    // --- Indexing ---

    /**
     * Ensure a node's inputs and reverse dependencies are indexed in the schema sublevels.
     * This adds the necessary put operations to the batch array.
     * 
     * @param {string} node - Canonical node key
     * @param {string[]} inputs - Array of canonical input keys
     * @param {Array<GenericBatchOp>} batchOps - Batch operations array to append to
     * @returns {Promise<void>}
     */
    async function ensureNodeIndexed(node, inputs, batchOps) {
        // Check if inputs are already indexed (optimization to avoid redundant writes)
        const existingInputs = await getInputs(node);
        if (existingInputs !== null) {
            // Already indexed, skip
            return;
        }

        // Store the inputs list for this node in the inputs sublevel
        /** @type {InputsRecord} */
        const inputsRecord = { inputs };
        batchOps.push({
            type: "put",
            sublevel: "schemas",
            schemaHash,
            nestedSublevel: "inputs",
            key: node,
            value: inputsRecord,
        });

        // Store reverse dependency edges in the revdeps sublevel
        for (const input of inputs) {
            // Key format: "<input>:<node>"
            const revdepKey = `${input}:${node}`;
            batchOps.push({
                type: "put",
                sublevel: "schemas",
                schemaHash,
                nestedSublevel: "revdeps",
                key: revdepKey,
                value: null,
            });
        }
    }

    /**
     * List all nodes that depend on the given input.
     * Queries the revdeps sublevel for all keys with the input prefix.
     * 
     * @param {string} input - Canonical input key
     * @returns {Promise<string[]>} Array of dependent node keys
     */
    async function listDependents(input) {
        const dependents = [];
        const prefix = `${input}:`;
        
        try {
            for await (const key of schemaStorage.revdeps.keys({
                gte: prefix,
                lte: prefix + "\xFF",
            })) {
                // Extract node name from key format "<input>:<node>"
                const node = key.substring(prefix.length);
                dependents.push(node);
            }
        } catch (err) {
            // If sublevel doesn't exist or other error, return empty array
            return [];
        }

        return dependents;
    }

    /**
     * Get the inputs for a node from the inputs sublevel.
     * Returns null if the node hasn't been indexed yet.
     * 
     * @param {string} node - Canonical node key
     * @returns {Promise<string[] | null>} Array of input keys, or null if not indexed
     */
    async function getInputs(node) {
        try {
            const record = await schemaStorage.inputs.get(node);
            if (record && typeof record === "object" && "inputs" in record) {
                return record.inputs;
            }
            return null;
        } catch (err) {
            // Level throws for missing keys, return null
            return null;
        }
    }

    /**
     * List all materialized nodes (nodes with values in the values sublevel).
     * @returns {Promise<string[]>}
     */
    async function listMaterializedNodes() {
        const nodes = [];
        try {
            for await (const key of database.values.keys()) {
                nodes.push(key);
            }
        } catch (err) {
            // If sublevel doesn't exist or other error, return empty array
            return [];
        }
        return nodes;
    }

    return {
        getNodeValue,
        getNodeFreshness,
        setNodeValueOp,
        setNodeFreshnessOp,
        ensureNodeIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

module.exports = {
    makeGraphStorage,
};
