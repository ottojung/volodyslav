/**
 * Migration runner for incremental-graph database version upgrades.
 *
 * Provides runMigration() which:
 * 1. Reads x/meta.version to decide whether migration is needed.
 * 2. Clears the staging namespace ("y") and runs the migration callback.
 * 3. Applies migration decisions to "y".
 * 4. Atomically swaps "y" into "x" (delete x/*, copy y/* → x/*, delete y/*, write version).
 */

const { compileNodeDef } = require("./compiled_node");
const { stringToNodeKeyString } = require("./database");
const { withExclusiveMode } = require("./lock");
const { makeMigrationStorage } = require("./migration_storage");
const { runMigrationInTransaction } = require("./database");
const { compareNodeKeyStringByNodeKey } = require("./database");
const { makeInMemorySchemaStorage, makeDbToDbAdapter, unifyStores } = require("./database/unification");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Counter} Counter */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').InputsRecord} InputsRecord */
/** @typedef {import('./database/types').TimestampRecord} TimestampRecord */
/** @typedef {import('./database/types').DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./migration_storage').Decision} Decision */

/**
 * @typedef {import("../../logger").Logger} Logger
 * @typedef {import("../../level_database").LevelDatabase} LevelDatabase
 * @typedef {import("../../environment").Environment} Environment
 * @typedef {import("../../filesystem/reader").FileReader} FileReader
 * @typedef {import("../../filesystem/checker").FileChecker} FileChecker
 * @typedef {import("../../filesystem/mover").FileMover} FileMover
 * @typedef {import("../../filesystem/creator").FileCreator} FileCreator
 * @typedef {import("../../filesystem/deleter").FileDeleter} FileDeleter
 * @typedef {import("../../filesystem/dirscanner").DirScanner} DirScanner
 * @typedef {import("../../filesystem/writer").FileWriter} FileWriter
 * @typedef {import("../../filesystem/copier").FileCopier} FileCopier
 * @typedef {import("../../filesystem/appender").FileAppender} FileAppender
 * @typedef {import("../../subprocess/command").Command} Command
 * @typedef {import("../../sleeper").SleepCapability} SleepCapability
 * @typedef {import("../../datetime").Datetime} Datetime
 * @typedef {import("../../ai/calories").AICalories} AICalories
 * @typedef {import('../../generators/interface').Interface} Interface
 */

/**
 * @typedef {object} Capabilities
 * @property {Logger} logger - Logger for informational messages during migration.
 * @property {SleepCapability} sleeper - Sleeper capability for mutex operations.
 * @property {FileChecker} checker - A file checker instance
 * @property {FileMover} mover - A file mover instance
 * @property {FileCreator} creator - A file creator instance
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {DirScanner} scanner - A directory scanner instance
 * @property {Command} git - A command instance for Git operations.
 * @property {FileReader} reader - A file reader instance
 * @property {FileWriter} writer - A file writer instance
 * @property {LevelDatabase} levelDatabase - A level database instance
 * @property {Environment} environment - An environment instance
 * @property {Datetime} datetime - Datetime utilities.
 * @property {Interface} interface - An interface instance with an update() method.
 */

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
        if (decision.kind === "create") continue; // Skip: newly created nodes have no previous inputs to migrate

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

        if (decision.kind === "create") {
            // New node - write with initial value and empty inputs record.
            ops.push(newStorage.values.putOp(nodeKey, await decision.value(nodeKey)));
            ops.push(newStorage.freshness.putOp(nodeKey, "up-to-date"));
            ops.push(newStorage.inputs.putOp(nodeKey, { inputs: [], inputCounters: [] }));
            ops.push(newStorage.counters.putOp(nodeKey, 1));
            continue;
        }

        const inputsRecord = await prevStorage.inputs.get(nodeKey);
        if (!inputsRecord) continue;

        // Copy inputs record (all non-deleted nodes keep their graph structure).
        ops.push(newStorage.inputs.putOp(nodeKey, inputsRecord));

        // Copy timestamps — preserve creation and modification history across migration.
        const timestamp = await prevStorage.timestamps.get(nodeKey);
        if (timestamp !== undefined) {
            ops.push(newStorage.timestamps.putOp(nodeKey, timestamp));
        }

        if (decision.kind === "keep") {
            const value = await prevStorage.values.get(nodeKey);
            if (value !== undefined) {
                ops.push(newStorage.values.putOp(nodeKey, value));
            }
            const oldFreshness = await prevStorage.freshness.get(nodeKey);
            if (oldFreshness !== undefined) {
                ops.push(newStorage.freshness.putOp(nodeKey, oldFreshness));
            }
            const counter = await prevStorage.counters.get(nodeKey);
            if (counter !== undefined) {
                ops.push(newStorage.counters.putOp(nodeKey, counter));
            }
        } else if (decision.kind === "override") {
            ops.push(newStorage.values.putOp(nodeKey, await decision.value(nodeKey)));
            ops.push(newStorage.freshness.putOp(nodeKey, "up-to-date"));
            const prevCounter = await prevStorage.counters.get(nodeKey);
            const newCounter = prevCounter !== undefined ? prevCounter + 1 : 1;
            ops.push(newStorage.counters.putOp(nodeKey, newCounter));
        } else if (decision.kind === "invalidate") {
            // No value; mark potentially-outdated so graph recomputes on next pull.
            ops.push(
                newStorage.freshness.putOp(nodeKey, "potentially-outdated")
            );
            const counter = await prevStorage.counters.get(nodeKey);
            if (counter !== undefined) {
                ops.push(newStorage.counters.putOp(nodeKey, counter));
            }
        }
    }

    // Write reverse-deps for all non-deleted input nodes.
    for (const [inputStr, depSet] of newRevdeps) {
        const inputKey = stringToNodeKeyString(inputStr);
        const dependents = [...depSet].sort(compareNodeKeyStringByNodeKey);
        ops.push(
            newStorage.revdeps.putOp(inputKey, dependents)
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
 * Uses a replica-pointer-swap strategy: writes the desired state to an
 * in-memory store, gently unifies it into the inactive replica (writing only
 * changed keys, deleting stale ones), then atomically switches the pointer.
 * A failed migration leaves the active replica unchanged.
 *
 * @param {Capabilities} capabilities - Capabilities needed to run the migration
 * @param {RootDatabase} rootDatabase - Opened root database
 * @param {Array<NodeDef>} nodeDefs - New-version schema node definitions
 * @param {(storage: MigrationStorage) => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function runMigration(capabilities, rootDatabase, nodeDefs, callback) {
    return await withExclusiveMode(capabilities.sleeper, async () => {
        await runMigrationUnsafe(capabilities, rootDatabase, nodeDefs, callback);
    });
}

/**
 * @typedef {import('./types').Version} Version
 */

/**
 * The unlocked version of runMigration. Should not be called directly.
 *
 * @param {Capabilities} capabilities - Capabilities needed to run the migration
 * @param {RootDatabase} rootDatabase - Opened root database
 * @param {Array<NodeDef>} nodeDefs - New-version schema node definitions
 * @param {(storage: MigrationStorage) => Promise<void>} callback
 * @returns {Promise<void>}
 */
async function runMigrationUnsafe(capabilities, rootDatabase, nodeDefs, callback)
{
    /** @type {Version | undefined} */
    const prevVersion = await rootDatabase.getMetaVersion();
    if (prevVersion === undefined) {
        // No previous version recorded; fresh database: record current version, nothing to migrate.
        await rootDatabase.setMetaVersion(rootDatabase.version);
        return;
    }

    const currentVersion = rootDatabase.version;
    if (prevVersion === currentVersion) {
        // Already on the current version.
        return;
    }

    capabilities.logger.logInfo({
        prevVersion, currentVersion
    }, `Starting migration from ${String(prevVersion)} to ${String(currentVersion)}`);

    await runMigrationInTransaction(
        capabilities,
        rootDatabase,
        `pre-migration: ${String(prevVersion)} → ${String(currentVersion)}`,
        `post-migration: ${String(currentVersion)}`,
        async () => {
            const fromReplica = rootDatabase.currentReplicaName();
            const toReplica = rootDatabase.otherReplicaName();

            const prevStorage = rootDatabase.schemaStorageForReplica(fromReplica);

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

            // Compute the desired state for the target replica by applying
            // decisions to a temporary in-memory store, then unify that
            // desired state into the actual target replica.  This avoids
            // clearing the target first and minimises unnecessary writes.
            const desiredStorage = makeInMemorySchemaStorage();

            // Apply decisions atomically to the desired state store.
            await applyDecisions(prevStorage, desiredStorage, decisions);

            // The inactive replica may still carry the old application version
            // in its meta sublevel.  Set the new version now — before calling
            // unifyStores — so that SchemaStorage.batch() does not reject writes
            // with SchemaBatchVersionError on the first flushed chunk.
            //
            // It is safe to write to the inactive replica before cutover:
            // the replica's intermediate state is irrelevant until
            // switchToReplica() succeeds.  A crash here leaves the active
            // replica untouched.
            const toStorage = rootDatabase.schemaStorageForReplica(toReplica);
            await rootDatabase.setMetaVersionForReplica(toReplica, rootDatabase.version);

            // Gently unify the desired state into the target replica.
            // Only changed keys are written; stale keys are deleted.
            const adapter = makeDbToDbAdapter(desiredStorage, toStorage);
            await unifyStores(adapter);

            // Switch the active replica pointer to the target replica.
            // This is the atomic cutover: only runs after all writes succeed.
            await rootDatabase.switchToReplica(toReplica);
        }
    );

    capabilities.logger.logInfo({
        prevVersion, currentVersion
    }, `Migration from ${String(prevVersion)} to ${String(currentVersion)} completed successfully.`);
}

module.exports = {
    runMigration,
    runMigrationUnsafe,
};
