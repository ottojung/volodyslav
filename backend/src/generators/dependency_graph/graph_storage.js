/**
 * GraphStorage module.
 * Encapsulates database access for the dependency graph using typed sublevels.
 */

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

/**
 * Interface for batch operations on a specific database.
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: string, value: TValue) => void} put - Queue a put operation
 * @property {(key: string) => void} del - Queue a delete operation
 */

/**
 * Batch builder for atomic operations across multiple databases.
 * Each database field is properly typed - no unions or type casts needed.
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<DatabaseValue>} values - Batch operations for values database
 * @property {BatchDatabaseOps<Freshness>} freshness - Batch operations for freshness database
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Batch operations for inputs database
 * @property {BatchDatabaseOps<string[]>} revdeps - Batch operations for revdeps database
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
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (input -> dependent array)
 * @property {BatchFunction} withBatch - Run a function and commit atomically everything it does
 * @property {(node: string, inputs: string[], batch: BatchBuilder) => Promise<void>} ensureNodeIndexed - Index a node's dependencies
 * @property {(input: string) => Promise<string[]>} listDependents - List all dependents of an input
 * @property {(node: string) => Promise<string[] | null>} getInputs - Get inputs for a node
 * @property {() => Promise<string[]>} listMaterializedNodes - List all materialized node names
 */

/**
 * Creates a batch builder for atomic operations.
 * @param {SchemaStorage} schemaStorage - The schema storage instance
 * @returns {BatchFunction}
 */
function makeBatchBuilder(schemaStorage) {
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
            put: (key, value) => operations.push(schemaStorage.freshness.putOp(key, value)),
            del: (key) => operations.push(schemaStorage.freshness.delOp(key)),
        },
        inputs: {
            put: (key, value) => operations.push(schemaStorage.inputs.putOp(key, value)),
            del: (key) => operations.push(schemaStorage.inputs.delOp(key)),
        },
        revdeps: {
            put: (key, value) => operations.push(schemaStorage.revdeps.putOp(key, value)),
            del: (key) => operations.push(schemaStorage.revdeps.delOp(key)),
        },
    };

    /** @type {BatchFunction} */
    const ret = async (fn) => {
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
 * @param {string} schemaHash - The schema hash for namespacing
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase, schemaHash) {
    const schemaStorage = rootDatabase.getSchemaStorage(schemaHash);

    /**
     * Ensure a node's inputs and reverse dependencies are indexed.
     * @param {string} node - Canonical node key
     * @param {string[]} inputs - Array of canonical input keys
     * @param {BatchBuilder} batch - Batch builder for atomic operations
     * @returns {Promise<void>}
     */
    async function ensureNodeIndexed(node, inputs, batch) {
        // Check if already indexed
        const existingInputs = await getInputs(node);
        if (existingInputs !== null) {
            return; // Already indexed
        }

        // Store the inputs record
        batch.inputs.put(node, { inputs });

        // Update revdeps using structured values (arrays)
        for (const input of inputs) {
            const existingDeps = (await schemaStorage.revdeps.get(input)) || [];
            if (!existingDeps.includes(node)) {
                batch.revdeps.put(input, [...existingDeps, node]);
            }
        }
    }

    /**
     * List all dependents of an input.
     * @param {string} input - Canonical input key
     * @returns {Promise<string[]>}
     */
    async function listDependents(input) {
        // Simple array lookup - no iteration or string manipulation
        return (await schemaStorage.revdeps.get(input)) || [];
    }

    /**
     * Get inputs for a node.
     * @param {string} node - Canonical node key
     * @returns {Promise<string[] | null>}
     */
    async function getInputs(node) {
        const record = await schemaStorage.inputs.get(node);
        return record ? record.inputs : null;
    }

    /**
     * List all materialized nodes.
     * @returns {Promise<string[]>}
     */
    async function listMaterializedNodes() {
        const keys = [];
        for await (const key of schemaStorage.values.keys()) {
            keys.push(key);
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
        ensureNodeIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

module.exports = {
    makeGraphStorage,
};
