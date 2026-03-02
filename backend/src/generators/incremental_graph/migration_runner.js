/**
 * Migration runner for incremental-graph database version upgrades.
 *
 * Provides runMigration() which:
 * 1. Opens the previous + current version namespaces.
 * 2. Executes the user-supplied migration callback with a MigrationStorage instance.
 * 3. Performs strict validation (DELETE fan-in, completeness).
 * 4. Applies migration decisions atomically.
 */

const { compileNodeDef } = require("./compiled_node");
const { stringToNodeKeyString } = require("./database");
const { makeMigrationStorage } = require("./migration_storage");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Counter} Counter */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').InputsRecord} InputsRecord */
/** @typedef {import('./database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./migration_storage').Decision} Decision */

/**
 * Collect all materialized node keys from a schema storage.
 * @param {SchemaStorage} storage
 * @returns {Promise<NodeKeyString[]>}
 */
async function loadMaterializedNodes(storage) {
    /** @type {NodeKeyString[]} */
    const nodes = [];
    for await (const key of storage.inputs.keys()) {
        nodes.push(key);
    }
    return nodes;
}

/**
 * Apply a finalized decisions map to the new version's storage.
 * Writes are committed atomically via a single batch call.
 * @param {SchemaStorage} prevStorage
 * @param {SchemaStorage} newStorage
 * @param {Map<NodeKeyString, Decision>} decisions
 * @returns {Promise<void>}
 */
async function applyDecisions(prevStorage, newStorage, decisions) {
    /** @type {DatabaseBatchOperation[]} */
    const ops = [];

    // Build reverse-deps for the new version from non-deleted nodes.
    /** @type {Map<string, Set<NodeKeyString>>} */
    const newRevdeps = new Map();

    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "delete") continue;

        const inputsRecord = await prevStorage.inputs.get(nodeKey);
        if (!inputsRecord) continue;

        for (const inputStr of inputsRecord.inputs) {
            const inputKey = stringToNodeKeyString(inputStr);
            const inputDecision = decisions.get(inputKey);
            if (inputDecision && inputDecision.kind === "delete") continue;
            const existing = newRevdeps.get(inputStr);
            if (existing) {
                existing.add(nodeKey);
            } else {
                newRevdeps.set(inputStr, new Set([nodeKey]));
            }
        }
    }

    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "delete") continue;

        const inputsRecord = await prevStorage.inputs.get(nodeKey);
        if (!inputsRecord) continue;

        // Write inputs record (all non-deleted nodes keep their graph structure).
        ops.push(newStorage.inputs.putOp(nodeKey, inputsRecord));

        if (decision.kind === "keep") {
            const value = await prevStorage.values.get(nodeKey);
            if (value !== undefined) {
                ops.push(newStorage.values.putOp(nodeKey, value));
            }
            ops.push(newStorage.freshness.putOp(nodeKey, "up-to-date"));
            const counter = await prevStorage.counters.get(nodeKey);
            if (counter !== undefined) {
                ops.push(newStorage.counters.putOp(nodeKey, counter));
            }
        } else if (decision.kind === "override") {
            ops.push(newStorage.values.putOp(nodeKey, decision.value));
            ops.push(newStorage.freshness.putOp(nodeKey, "up-to-date"));
            const prevCounter = await prevStorage.counters.get(nodeKey);
            const newCounter = prevCounter !== undefined ? prevCounter + 1 : 1;
            ops.push(newStorage.counters.putOp(nodeKey, newCounter));
        } else if (decision.kind === "invalidate") {
            // No value; mark potentially-outdated so graph recomputes on next pull.
            ops.push(
                newStorage.freshness.putOp(nodeKey, "potentially-outdated")
            );
        }
    }

    // Write reverse-deps for all non-deleted input nodes.
    for (const [inputStr, depSet] of newRevdeps) {
        const inputKey = stringToNodeKeyString(inputStr);
        ops.push(
            newStorage.revdeps.putOp(inputKey, [...depSet])
        );
    }

    await newStorage.batch(ops);
}

/**
 * Run a database migration.
 *
 * The callback receives a MigrationStorage instance and must assign exactly one
 * decision (keep / override / invalidate / delete) to every node materialized in
 * the previous application version.  Propagation rules and completeness are
 * enforced automatically; any violation throws before the new version is written.
 *
 * @param {RootDatabase} rootDatabase - Opened root database (current version is new)
 * @param {Array<NodeDef>} nodeDefs - New-version schema node definitions
 * @param {(storage: MigrationStorage) => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function runMigration(rootDatabase, nodeDefs, callback) {
    // version.  Version strings are application git-hashes (opaque), so we
    // cannot order them numerically.  In practice exactly two versions exist at
    // migration time: the old one and the new one that has not been written yet.
    // If somehow more than two exist, the last non-current version encountered
    // during iteration is used; authors needing a specific prior version should
    // pass it explicitly via a future overload.
    /** @type {import('./database/types').Version | undefined} */
    let prevVersion = await rootDatabase.lastSchema();
    if (prevVersion === undefined) {
        // No previous version; nothing to migrate.
        return;
    }

    const prevStorage = rootDatabase.getSchemaStorageForVersion(prevVersion);
    const newStorage = rootDatabase.getSchemaStorage();

    // Compile new schema and build head index for compatibility checks.
    const compiledNodes = nodeDefs.map(compileNodeDef);
    /** @type {Map<NodeName, CompiledNode>} */
    const newHeadIndex = new Map(compiledNodes.map((n) => [n.head, n]));

    // Load previous-version materialized nodes.
    const materializedNodes = await loadMaterializedNodes(prevStorage);

    // Create the MigrationStorage for the user callback.
    const migrationStorage = makeMigrationStorage(
        prevStorage,
        newHeadIndex,
        materializedNodes
    );

    // Execute user migration callback.
    await callback(migrationStorage);

    // Finalize: propagate deletes, check fan-in, check completeness.
    const decisions = await migrationStorage.finalize();

    // Apply decisions atomically to the new version's storage.
    await applyDecisions(prevStorage, newStorage, decisions);
}

module.exports = {
    runMigration,
};
