/**
 * Migration runner for incremental-graph database version upgrades.
 *
 * Provides runMigration() which:
 * 1. Reads x/global/version to decide whether migration is needed.
 * 2. Runs the migration callback against the current (x) replica.
 * 3. Gently unifies the desired new state into the inactive (y) replica,
 *    including the new version in y/global/version via the lazy source.
 * 4. Atomically switches the replica pointer from x to y.
 */

const { compileNodeDef } = require("./compiled_node");
const { stringToNodeKeyString } = require("./database");
const { withExclusiveMode } = require("./lock");
const { makeMigrationStorage } = require("./migration_storage");
const { checkpointMigration } = require("./database");
const { compareNodeKeyStringByNodeKey } = require("./database");
const { unifyStores, makeDbToDbAdapter } = require("./database");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Counter} Counter */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').InputsRecord} InputsRecord */
/** @typedef {import('./database/types').TimestampRecord} TimestampRecord */
/** @typedef {import('./database').ReadableSchemaStorage} ReadableSchemaStorage */
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
 * Build the desired revdeps map from decisions, reading inputs from prevStorage.
 *
 * Memory: O(|keys|) — only stores key strings in the result map; no large
 * values are retained.  Reads from prevStorage are streaming (one InputsRecord
 * at a time).
 *
 * @param {SchemaStorage} prevStorage
 * @param {Map<NodeKeyString, Decision>} decisions
 * @returns {Promise<Map<NodeKeyString, NodeKeyString[]>>}
 */
async function buildDesiredRevdeps(prevStorage, decisions) {
    /** @type {Map<string, Set<NodeKeyString>>} */
    const revdepSets = new Map();

    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "delete" || decision.kind === "create") continue;

        const inputsRecord = await prevStorage.inputs.get(nodeKey);
        if (!inputsRecord) continue;

        for (const inputStr of inputsRecord.inputs) {
            const inputKey = stringToNodeKeyString(inputStr);
            const inputDecision = decisions.get(inputKey);
            if (inputDecision && inputDecision.kind === "delete") continue;
            const existing = revdepSets.get(inputStr);
            if (existing) {
                existing.add(nodeKey);
            } else {
                revdepSets.set(inputStr, new Set([nodeKey]));
            }
        }
    }

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const result = new Map();
    for (const [inputStr, depSet] of revdepSets) {
        const inputKey = stringToNodeKeyString(inputStr);
        result.set(inputKey, [...depSet].sort(compareNodeKeyStringByNodeKey));
    }
    return result;
}

/**
 * Create a lazy read-only source that yields the desired migration state.
 *
 * Values are computed from prevStorage on demand — no values are accumulated
 * in memory simultaneously.  Combined with makeDbToDbAdapter + unifyStores this
 * achieves O(|max value| + |keys|) peak memory for migration, matching sync.
 *
 * For 'keep' decisions the target sublevel value is read twice (once during
 * keys() to check existence, once during readSource()) — this is an I/O
 * trade-off that avoids per-value memory retention.
 *
 * @param {SchemaStorage} prevStorage
 * @param {Map<NodeKeyString, Decision>} decisions
 * @param {Map<NodeKeyString, NodeKeyString[]>} desiredRevdeps
 * @param {import('./database/types').Version} newVersion
 * @returns {ReadableSchemaStorage}
 */
function makeLazyMigrationSource(prevStorage, decisions, desiredRevdeps, newVersion) {
    // Sort decision keys once so every sublevel's keys() yields in the same
    // order as LevelDB.  Keys are latin1 strings (no "!!" substring), so JS
    // default string sort matches LevelDB byte order.
    // TODO: ConstValue arguments may contain non-latin1 characters; that case
    // is tracked separately and will be addressed in a future change.
    const sortedDecisionKeys = [...decisions.keys()].sort();

    const sortedRevdepKeys = [...desiredRevdeps.keys()].sort();

    return {
        values: {
            async *keys() {
                for (const nodeKey of sortedDecisionKeys) {
                    const decision = decisions.get(nodeKey);
                    if (!decision) continue;
                    if (decision.kind === "delete") continue;
                    if (decision.kind === "create" || decision.kind === "override") {
                        yield nodeKey;
                    } else if (decision.kind === "keep") {
                        const v = await prevStorage.values.get(nodeKey);
                        if (v !== undefined) yield nodeKey;
                    }
                    // 'invalidate': no value in values sublevel
                }
            },
            async get(/** @type {NodeKeyString} */ key) {
                const decision = decisions.get(key);
                if (!decision) return undefined;
                if (decision.kind === "create" || decision.kind === "override") {
                    return await decision.value(key);
                }
                return await prevStorage.values.get(key);
            },
        },
        freshness: {
            async *keys() {
                for (const nodeKey of sortedDecisionKeys) {
                    const decision = decisions.get(nodeKey);
                    if (!decision) continue;
                    if (decision.kind === "delete") continue;
                    if (decision.kind === "create" || decision.kind === "override" || decision.kind === "invalidate") {
                        yield nodeKey;
                    } else if (decision.kind === "keep") {
                        const f = await prevStorage.freshness.get(nodeKey);
                        if (f !== undefined) yield nodeKey;
                    }
                }
            },
            async get(/** @type {NodeKeyString} */ key) {
                const decision = decisions.get(key);
                if (!decision) return undefined;
                if (decision.kind === "create" || decision.kind === "override") return "up-to-date";
                if (decision.kind === "invalidate") return "potentially-outdated";
                return await prevStorage.freshness.get(key);
            },
        },
        inputs: {
            async *keys() {
                for (const nodeKey of sortedDecisionKeys) {
                    const decision = decisions.get(nodeKey);
                    if (!decision) continue;
                    if (decision.kind === "delete") continue;
                    if (decision.kind === "create") {
                        yield nodeKey;
                    } else {
                        const ir = await prevStorage.inputs.get(nodeKey);
                        if (ir !== undefined) yield nodeKey;
                    }
                }
            },
            async get(/** @type {NodeKeyString} */ key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") return { inputs: [], inputCounters: [] };
                return await prevStorage.inputs.get(key);
            },
        },
        revdeps: {
            async *keys() {
                for (const key of sortedRevdepKeys) {
                    yield key;
                }
            },
            async get(/** @type {NodeKeyString} */ key) {
                return desiredRevdeps.get(key);
            },
        },
        counters: {
            async *keys() {
                for (const nodeKey of sortedDecisionKeys) {
                    const decision = decisions.get(nodeKey);
                    if (!decision) continue;
                    if (decision.kind === "delete") continue;
                    if (decision.kind === "create" || decision.kind === "override") {
                        yield nodeKey;
                    } else {
                        const c = await prevStorage.counters.get(nodeKey);
                        if (c !== undefined) yield nodeKey;
                    }
                }
            },
            async get(/** @type {NodeKeyString} */ key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") return 1;
                if (decision.kind === "override") {
                    const prev = await prevStorage.counters.get(key);
                    return prev !== undefined ? prev + 1 : 1;
                }
                return await prevStorage.counters.get(key);
            },
        },
        timestamps: {
            async *keys() {
                for (const nodeKey of sortedDecisionKeys) {
                    const decision = decisions.get(nodeKey);
                    if (!decision) continue;
                    if (decision.kind === "delete" || decision.kind === "create") continue;
                    const ts = await prevStorage.timestamps.get(nodeKey);
                    if (ts !== undefined) yield nodeKey;
                }
            },
            async get(/** @type {NodeKeyString} */ key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete" || decision.kind === "create") return undefined;
                return await prevStorage.timestamps.get(key);
            },
        },
        global: {
            async *keys() {
                yield stringToNodeKeyString('version');
            },
            async get(/** @type {NodeKeyString} */ _key) {
                return newVersion;
            },
        },
    };
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
    const prevVersion = await rootDatabase.getGlobalVersion();
    if (prevVersion === undefined) {
        // No previous version recorded; fresh database: record current version, nothing to migrate.
        await rootDatabase.setGlobalVersion(rootDatabase.version);
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

    await checkpointMigration(
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

            const toStorage = rootDatabase.schemaStorageForReplica(toReplica);

            // Build the desired revdeps map.  Reads inputs from prevStorage once
            // per non-create/non-delete node; stores only key strings, O(|keys|) mem.
            const desiredRevdeps = await buildDesiredRevdeps(prevStorage, decisions);

            // Create a lazy source that computes desired values on demand.
            // Combined with makeDbToDbAdapter + unifyStores this keeps peak
            // memory at O(|max value| + |keys|), matching the sync path.
            const lazySource = makeLazyMigrationSource(prevStorage, decisions, desiredRevdeps, currentVersion);

            // Gently unify the desired state into the target replica.
            // Only changed keys are written; stale keys are deleted first.
            // The new version is included in the lazy source's global sublevel,
            // so it is written atomically with the data — no separate version write.
            await unifyStores(makeDbToDbAdapter(lazySource, toStorage));

            // One final fsync: all unification writes use sync:false for performance;
            // _rawSync() issues an empty batch with sync:true to flush the WAL
            // without rewriting any keys.
            await rootDatabase._rawSync();

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
