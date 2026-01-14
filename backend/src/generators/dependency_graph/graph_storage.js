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
/** @typedef {import('./database/root_database').CountersDatabase} CountersDatabase */
/** @typedef {import('./database/types').DatabaseValue} DatabaseValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').Counter} Counter */
/** @typedef {import('./database/types').InputsRecord} InputsRecord */
/** @typedef {import('./database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./database/types').SchemaSublevelType} SchemaSublevelType */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').SchemaHash} SchemaHash */
/** @typedef {import('./database/types').DatabaseKey} DatabaseKey */

/**
 * @template T
 * @typedef {import('./database/types').DatabasePutOperation<T>} DatabasePutOperation
 */

/**
 * @template T
 * @typedef {import('./database/types').DatabaseDelOperation<T>} DatabaseDelOperation
 */

/**
 * Interface for batch operations on a specific database.
 * Provides transactional view with read-your-writes consistency.
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: DatabaseKey, value: TValue) => void} put - Queue a put operation
 * @property {(key: DatabaseKey) => void} del - Queue a delete operation
 * @property {(key: DatabaseKey) => Promise<TValue | undefined>} get - Read with batch consistency
 */

/**
 * Batch builder for atomic operations across multiple databases.
 * Each database field is properly typed - no unions or type casts needed.
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<DatabaseValue>} values - Batch operations for values database
 * @property {BatchDatabaseOps<Freshness>} freshness - Batch operations for freshness database
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Batch operations for inputs database
 * @property {BatchDatabaseOps<NodeKeyString[]>} revdeps - Batch operations for revdeps database (input node -> array of dependents)
 * @property {BatchDatabaseOps<Counter>} counters - Batch operations for counters database (monotonic integers)
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
 * @property {CountersDatabase} counters - Node counters (monotonic integers)
 * @property {BatchFunction} withBatch - Run a function and commit atomically everything it does
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Mark a node as materialized (write inputs record)
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed - Index reverse dependencies (write revdep arrays)
 * @property {(input: NodeKeyString, batch: BatchBuilder) => Promise<NodeKeyString[]>} listDependents - List all dependents of an input (requires batch for consistency)
 * @property {(node: NodeKeyString, batch: BatchBuilder) => Promise<NodeKeyString[] | null>} getInputs - Get inputs for a node (requires batch for consistency)
 * @property {() => Promise<NodeKeyString[]>} listMaterializedNodes - List all materialized node names
 */

/**
 * Creates a transactional database view for batch-consistent reads.
 * Implements read-your-writes semantics within a batch.
 * @template TValue
 * @param {import('./database/typed_database').GenericDatabase<TValue>} db - The underlying database
 * @param {Array<DatabasePutOperation<TValue> | DatabaseDelOperation<TValue>>} operations - Array to append operations to
 * @param {Map<DatabaseKey, TValue>} pendingPuts - Overlay of pending put operations
 * @param {Set<DatabaseKey>} pendingDels - Set of pending delete operations
 * @returns {BatchDatabaseOps<TValue>}
 */
function makeTxDb(db, operations, pendingPuts, pendingDels) {
    return {
        /**
         * Queue a put operation and record in overlay.
         * @param {DatabaseKey} key
         * @param {TValue} value
         */
        put: (key, value) => {
            pendingPuts.set(key, value);
            pendingDels.delete(key);
            operations.push(db.putOp(key, value));
        },

        /**
         * Queue a delete operation and record in overlay.
         * @param {DatabaseKey} key
         */
        del: (key) => {
            pendingDels.add(key);
            pendingPuts.delete(key);
            operations.push(db.delOp(key));
        },

        /**
         * Get value with batch consistency.
         * Checks overlay before falling back to underlying database.
         * @param {DatabaseKey} key
         * @returns {Promise<TValue | undefined>}
         */
        get: async (key) => {
            // Check if deleted in this batch
            if (pendingDels.has(key)) {
                return undefined;
            }
            // Check if written in this batch
            if (pendingPuts.has(key)) {
                return pendingPuts.get(key);
            }
            // Fall back to underlying database
            return await db.get(key);
        },
    };
}

/**
 * Creates a batch builder for atomic operations.
 * @param {SchemaStorage} schemaStorage - The schema storage instance
 * @returns {BatchFunction}
 */
function makeBatchBuilder(schemaStorage) {
    /** @type {BatchFunction} */
    const ret = async (fn) => {
        // Create separate operations arrays for each sublevel
        /** @type {Array<DatabasePutOperation<DatabaseValue> | DatabaseDelOperation<DatabaseValue>>} */
        const valuesOps = [];
        /** @type {Array<DatabasePutOperation<Freshness> | DatabaseDelOperation<Freshness>>} */
        const freshnessOps = [];
        /** @type {Array<DatabasePutOperation<InputsRecord> | DatabaseDelOperation<InputsRecord>>} */
        const inputsOps = [];
        /** @type {Array<DatabasePutOperation<NodeKeyString[]> | DatabaseDelOperation<NodeKeyString[]>>} */
        const revdepsOps = [];
        /** @type {Array<DatabasePutOperation<Counter> | DatabaseDelOperation<Counter>>} */
        const countersOps = [];

        // Create overlay state for each sublevel
        /** @type {Map<DatabaseKey, DatabaseValue>} */
        const valuesPuts = new Map();
        /** @type {Set<DatabaseKey>} */
        const valuesDels = new Set();

        /** @type {Map<DatabaseKey, Freshness>} */
        const freshnessPuts = new Map();
        /** @type {Set<DatabaseKey>} */
        const freshnessDels = new Set();

        /** @type {Map<DatabaseKey, InputsRecord>} */
        const inputsPuts = new Map();
        /** @type {Set<DatabaseKey>} */
        const inputsDels = new Set();

        /** @type {Map<DatabaseKey, NodeKeyString[]>} */
        const revdepsPuts = new Map();
        /** @type {Set<DatabaseKey>} */
        const revdepsDels = new Set();

        /** @type {Map<DatabaseKey, Counter>} */
        const countersPuts = new Map();
        /** @type {Set<DatabaseKey>} */
        const countersDels = new Set();

        /** @type {BatchBuilder} */
        const builder = {
            values: makeTxDb(schemaStorage.values, valuesOps, valuesPuts, valuesDels),
            freshness: makeTxDb(schemaStorage.freshness, freshnessOps, freshnessPuts, freshnessDels),
            inputs: makeTxDb(schemaStorage.inputs, inputsOps, inputsPuts, inputsDels),
            revdeps: makeTxDb(schemaStorage.revdeps, revdepsOps, revdepsPuts, revdepsDels),
            counters: makeTxDb(schemaStorage.counters, countersOps, countersPuts, countersDels),
        };

        const value = await fn(builder);
        
        // Combine all operations into a single array for the batch
        /** @type {DatabaseBatchOperation[]} */
        const allOperations = [
            ...valuesOps,
            ...freshnessOps,
            ...inputsOps,
            ...revdepsOps,
            ...countersOps,
        ];
        
        await schemaStorage.batch(allOperations);
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
        // Check if already indexed (use batch-consistent read)
        const existingInputs = await batch.inputs.get(node);
        if (existingInputs !== undefined) {
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
            // Get existing dependents for this input (use batch-consistent read)
            const existingDependents = await batch.revdeps.get(input);

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
     * @param {BatchBuilder} batch - Batch builder for consistent reads
     * @returns {Promise<NodeKeyString[]>}
     */
    async function listDependents(input, batch) {
        const dependents = await batch.revdeps.get(input);
        if (dependents === undefined) {
            return [];
        }
        return dependents;
    }

    /**
     * Get inputs for a node.
     * @param {NodeKeyString} node - Canonical node key
     * @param {BatchBuilder} batch - Batch builder for consistent reads
     * @returns {Promise<NodeKeyString[] | null>}
     */
    async function getInputs(node, batch) {
        const record = await batch.inputs.get(node);
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
        for await (const key of schemaStorage.inputs.keys()) {
            if (typeof key !== "string") {
                throw new Error("Invalid key type in inputs database");
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
        counters: schemaStorage.counters,

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
