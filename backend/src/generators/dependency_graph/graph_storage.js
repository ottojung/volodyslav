/**
 * GraphStorage module.
 * Encapsulates database access for the dependency graph using typed sublevels.
 */

const { stringToNodeKeyString, nodeKeyStringToString } = require('../database/types');

/** @typedef {import('../database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('../database/root_database').ValuesDatabase} ValuesDatabase */
/** @typedef {import('../database/root_database').FreshnessDatabase} FreshnessDatabase */
/** @typedef {import('../database/root_database').InputsDatabase} InputsDatabase */
/** @typedef {import('../database/root_database').RevdepsDatabase} RevdepsDatabase */
/** @typedef {import('../database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('../database/types').Freshness} Freshness */
/** @typedef {import('../database/types').InputsRecord} InputsRecord */
/** @typedef {import('../database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('../database/types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').SchemaHash} SchemaHash */

/**
 * Interface for batch operations on a specific database.
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: NodeKeyString, value: TValue) => void} put - Queue a put operation
 * @property {(key: NodeKeyString) => void} del - Queue a delete operation
 */

/**
 * Batch builder for atomic operations across multiple databases.
 * Each database field is properly typed - no unions or type casts needed.
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<DatabaseValue>} values - Batch operations for values database
 * @property {BatchDatabaseOps<Freshness>} freshness - Batch operations for freshness database
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Batch operations for inputs database
 * @property {BatchDatabaseOps<1>} revdeps - Batch operations for revdeps database (edge-based storage)
 */

/**
 * @typedef {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} BatchFunction
 */

/**
 * GraphStorage exposes typed databases as fields.
 * All databases are from the same schema namespace.
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values - Node values
 * @property {FreshnessDatabase} freshness - Node freshness
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (edge-based: composite key -> 1)
 * @property {BatchFunction} withBatch - Run a function and commit atomically everything it does
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Mark a node as materialized (write inputs record)
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed - Index reverse dependencies (write revdep edges)
 * @property {(input: NodeKeyString) => Promise<NodeKeyString[]>} listDependents - List all dependents of an input
 * @property {(node: NodeKeyString) => Promise<NodeKeyString[] | null>} getInputs - Get inputs for a node
 * @property {() => Promise<NodeKeyString[]>} listMaterializedNodes - List all materialized node names
 */

/**
 * Creates a batch builder for atomic operations.
 * @param {SchemaStorage} schemaStorage - The schema storage instance
 * @returns {BatchFunction}
 */
function makeBatchBuilder(schemaStorage) {
    /** @type {BatchFunction} */
    const ret = async (fn) => {
        // Create a fresh operations array for each invocation
        /** @type {DatabaseBatchOperation[]} */
        const operations = [];

        /** @type {BatchBuilder} */
        const builder = {
            values: {
                put: (key, value) => {
                    const op = schemaStorage.values.putOp(key, value);
                    operations.push(op);
                },
                del: (key) => operations.push(schemaStorage.values.delOp(key)),
            },
            freshness: {
                put: (key, value) =>
                    operations.push(schemaStorage.freshness.putOp(key, value)),
                del: (key) =>
                    operations.push(schemaStorage.freshness.delOp(key)),
            },
            inputs: {
                put: (key, value) =>
                    operations.push(schemaStorage.inputs.putOp(key, value)),
                del: (key) => operations.push(schemaStorage.inputs.delOp(key)),
            },
            revdeps: {
                put: (key, value) =>
                    operations.push(schemaStorage.revdeps.putOp(key, value)),
                del: (key) => operations.push(schemaStorage.revdeps.delOp(key)),
            },
        };

        const value = await fn(builder);
        await schemaStorage.batch(operations);
        return value;
    };

    return ret;
}

const KEYSEPARATOR = "%";

/**
 * Create a composite key for an edge in the revdeps database.
 * Uses null byte as delimiter between input and dependent node names.
 * @param {NodeKeyString} input - The input node (canonical name)
 * @param {NodeKeyString} dependent - The dependent node (canonical name)
 * @returns {string}
 */
function makeRevdepKey(input, dependent) {
    const inputStr = nodeKeyStringToString(input);
    const dependentStr = nodeKeyStringToString(dependent);
    return `${inputStr}${KEYSEPARATOR}${dependentStr}`;
}

/**
 * Parse a composite key from the revdeps database.
 * @param {string} key - The composite key
 * @returns {{input: NodeKeyString, dependent: NodeKeyString}}
 */
function parseRevdepKey(key) {
    const parts = key.split(KEYSEPARATOR);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid revdep key format: ${key}`);
    }
    return { input: stringToNodeKeyString(parts[0]), dependent: stringToNodeKeyString(parts[1]) };
}

/**
 * Creates a GraphStorage instance using typed databases.
 *
 * @param {RootDatabase} rootDatabase - The root database instance
 * @param {SchemaHash} schemaHash - The schema hash for namespacing
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase, schemaHash) {
    const schemaStorage = rootDatabase.getSchemaStorage(schemaHash);

    /**
     * Ensure a node is marked as materialized in the inputs database.
     * This is always called regardless of whether the node has inputs.
     * Writes the inputs record for the node.
     * @param {NodeKeyString} node - Canonical node key
     * @param {NodeKeyString[]} inputs - Array of canonical input keys (may be empty)
     * @param {BatchBuilder} batch - Batch builder for atomic operations
     * @returns {Promise<void>}
     */
    async function ensureMaterialized(node, inputs, batch) {
        // Check if already indexed
        const existingInputs = await getInputs(node);
        if (existingInputs !== null) {
            return; // Already materialized
        }

        // Convert NodeKeyString[] to string[] for storage
        const inputsAsStrings = inputs.map(nodeKeyStringToString);
        // Store the inputs record (even if empty array)
        batch.inputs.put(node, { inputs: inputsAsStrings });
    }

    /**
     * Ensure a node's reverse dependencies are indexed.
     * This is only called when the node has inputs.
     * Writes reverse dependency edges.
     * @param {NodeKeyString} node - Canonical node key
     * @param {NodeKeyString[]} inputs - Array of canonical input keys (must be non-empty)
     * @param {BatchBuilder} batch - Batch builder for atomic operations
     * @returns {Promise<void>}
     */
    async function ensureReverseDepsIndexed(node, inputs, batch) {
        // Check if already indexed by checking if any revdep edge exists
        // We only check the first input to avoid too many DB reads
        if (inputs.length > 0) {
            const firstInput = inputs[0];
            // TypeScript doesn't understand that inputs[0] is defined when length > 0
            if (firstInput !== undefined) {
                const firstEdgeKey = makeRevdepKey(firstInput, node);
                // Cast: revdeps uses composite string keys, not NodeKeyString
                const existingEdge = await schemaStorage.revdeps.get(stringToNodeKeyString(firstEdgeKey));
                if (existingEdge !== undefined) {
                    return; // Already indexed, skip writing revdeps
                }
            }
        }

        // Update revdeps using edge-based storage
        // Each edge is stored as a separate key-value pair
        for (const input of inputs) {
            const edgeKey = makeRevdepKey(input, node);
            // Cast: revdeps uses composite string keys, not NodeKeyString
            batch.revdeps.put(stringToNodeKeyString(edgeKey), 1);
        }
    }

    /**
     * List all dependents of an input.
     * Iterates over all keys with the input prefix to collect dependents.
     * @param {NodeKeyString} input - Canonical input key
     * @returns {Promise<NodeKeyString[]>}
     */
    async function listDependents(input) {
        const dependents = [];
        const inputStr = nodeKeyStringToString(input);
        const prefix = `${inputStr}${KEYSEPARATOR}`;

        // Iterate over all keys that start with the input prefix
        // Cast: revdeps.keys() returns NodeKeyString but they're composite strings
        for await (const nodeKeyStringKey of schemaStorage.revdeps.keys()) {
            const key = nodeKeyStringToString(nodeKeyStringKey);
            if (key.startsWith(prefix)) {
                const { dependent } = parseRevdepKey(key);
                dependents.push(dependent);
            }
        }

        return dependents;
    }

    /**
     * Get inputs for a node.
     * @param {NodeKeyString} node - Canonical node key
     * @returns {Promise<NodeKeyString[] | null>}
     */
    async function getInputs(node) {
        const record = await schemaStorage.inputs.get(node);
        if (!record) return null;
        // Convert string[] from DB to NodeKeyString[]
        return record.inputs.map(stringToNodeKeyString);
    }

    /**
     * List all materialized nodes.
     * @returns {Promise<NodeKeyString[]>}
     */
    async function listMaterializedNodes() {
        const keys = [];
        for await (const key of schemaStorage.values.keys()) {
            keys.push(key); // key is already NodeKeyString
        }
        return keys;
    }

    return {
        // Expose all databases as fields
        values: schemaStorage.values,
        freshness: schemaStorage.freshness,
        inputs: schemaStorage.inputs,
        revdeps: schemaStorage.revdeps,

        // Batch builder for atomic operations
        withBatch: makeBatchBuilder(schemaStorage),

        // Helper methods
        ensureMaterialized,
        ensureReverseDepsIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

module.exports = {
    makeGraphStorage,
};
