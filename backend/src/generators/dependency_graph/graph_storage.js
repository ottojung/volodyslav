/**
 * GraphStorage module.
 * Encapsulates database access for the dependency graph using typed sublevels.
 */

const { stringToNodeKeyString, nodeKeyStringToString } = require("./database");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/root_database').ValuesDatabase} ValuesDatabase */
/** @typedef {import('./database/root_database').FreshnessDatabase} FreshnessDatabase */
/** @typedef {import('./database/root_database').InputsDatabase} InputsDatabase */
/** @typedef {import('./database/root_database').RevdepsDatabase} RevdepsDatabase */
/** @typedef {import('./database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').InputsRecord} InputsRecord */
/** @typedef {import('./database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./database/types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').SchemaHash} SchemaHash */
/** @typedef {import('./database/types').DatabaseKey} DatabaseKey */

/**
 * Interface for batch operations on a specific database.
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: DatabaseKey, value: TValue) => void} put - Queue a put operation
 * @property {(key: DatabaseKey) => void} del - Queue a delete operation
 */

/**
 * Batch builder for atomic operations across multiple databases.
 * Each database field is properly typed - no unions or type casts needed.
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<DatabaseValue>} values - Batch operations for values database
 * @property {BatchDatabaseOps<Freshness>} freshness - Batch operations for freshness database
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Batch operations for inputs database
 * @property {BatchDatabaseOps<NodeKeyString[]>} revdeps - Batch operations for revdeps database (input node -> array of dependents)
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
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (input node -> array of dependents)
 * @property {BatchFunction} withBatch - Run a function and commit atomically everything it does
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Mark a node as materialized (write inputs record)
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed - Index reverse dependencies (write revdep arrays)
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
     * Writes reverse dependency arrays.
     * @param {NodeKeyString} node - Canonical node key
     * @param {NodeKeyString[]} inputs - Array of canonical input keys (must be non-empty)
     * @param {BatchBuilder} batch - Batch builder for atomic operations
     * @returns {Promise<void>}
     */
    async function ensureReverseDepsIndexed(node, inputs, batch) {
        // For each input, add this node to its dependents array
        for (const input of inputs) {
            // Get existing dependents for this input
            const existingDependents = await schemaStorage.revdeps.get(input);

            if (existingDependents !== undefined) {
                // Check if this node is already in the dependents list
                if (existingDependents.includes(node)) {
                    continue; // Already indexed, skip
                }
                // Add this node to the existing dependents array
                batch.revdeps.put(input, [...existingDependents, node]);
            } else {
                // Create a new dependents array with just this node
                batch.revdeps.put(input, [node]);
            }
        }
    }

    /**
     * List all dependents of an input.
     * Returns the array of dependents stored for this input.
     * @param {NodeKeyString} input - Canonical input key
     * @returns {Promise<NodeKeyString[]>}
     */
    async function listDependents(input) {
        const dependents = await schemaStorage.revdeps.get(input);
        if (dependents === undefined) {
            return [];
        }
        // Convert string[] from DB to NodeKeyString[]
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
            if (typeof key !== "string") {
                throw new Error("Invalid key type in values database");
            }
            keys.push(stringToNodeKeyString(key));
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
