/* eslint volodyslav/max-lines-per-file: "off" */
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
const {
    allocateNodeIdentifier,
    compareNodeIdentifier,
    deterministicNodeIdentifierFromNodeKey,
    IDENTIFIERS_KEY,
    makeIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeNodeKey,
    serializeIdentifierLookup,
    stringToNodeIdentifier,
    stringToNodeKeyString,
    stringToNodeName,
    getRootDatabase,
} = require("./database");
const { withExclusiveMode } = require("./lock");
const { makeMigrationStorage, legacyStringToNodeIdentifier } = require("./migration_storage");
const { checkpointMigration } = require("./database");
const { unifyStores, makeDbToDbAdapter } = require("./database");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
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
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */
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
 * @property {import('../../random/seed').NonDeterministicSeed} seed - Random seed capability.
 */

/**
 * Collect all materialized node keys from a schema storage.
 * @param {SchemaStorage} storage
 * @returns {Promise<NodeIdentifier[]>}
 */
async function loadMaterializedNodes(storage) {
    /** @type {NodeIdentifier[]} */
    const nodes = [];
    for await (const key of storage.inputs.keys()) {
        nodes.push(key);
    }
    return nodes;
}

/**
 * Converts a plain zero-argument node name string to its canonical serialized node-key
 * form (i.e. the serialized `{"head":"<name>","args":[]}` representation). Used in
 * migration backwards-compatibility paths where
 * old database entries stored nodes by bare name rather than by serialized key.
 * @param {string} nodeName
 * @returns {NodeKeyString}
 */
function zeroArgNodeNameToNodeKeyString(nodeName) {
    return serializeNodeKey({ head: stringToNodeName(nodeName), args: [] });
}

/**
 * @param {NodeIdentifier} nodeKey
 * @returns {NodeKeyString}
 */
function canonicalizeMigrationNodeKey(nodeKey) {
    const nodeKeyString = String(nodeKey);
    if (nodeKeyString.startsWith("{")) {
        return stringToNodeKeyString(nodeKeyString);
    }
    return zeroArgNodeNameToNodeKeyString(nodeKeyString);
}

/**
 * @param {SchemaStorage} prevStorage
 * @param {NodeIdentifier[]} materializedNodes
 * @returns {Promise<{
 *   keyToSourceKey: (nodeKey: NodeIdentifier) => NodeIdentifier,
 *   keyToOutputKey: (nodeKey: NodeIdentifier) => NodeIdentifier,
 *   outputKeyToDecisionKey: (outputKey: NodeIdentifier) => NodeIdentifier,
 *   outputEntries: Array<[import('./database/types').NodeIdentifier, NodeKeyString]>,
 * }>}
 */
async function makeMigrationKeyPlan(prevStorage, materializedNodes) {
    const persistedEntries = await prevStorage.global.get(IDENTIFIERS_KEY);
    if (Array.isArray(persistedEntries)) {
        const lookup = makeIdentifierLookup(persistedEntries);
        /** @type {Map<string, NodeIdentifier>} */
        const decisionKeyByOutputKey = new Map();
        for (const [nodeIdentifier, nodeKey] of persistedEntries) {
            decisionKeyByOutputKey.set(
                String(nodeIdentifier),
                legacyStringToNodeIdentifier(String(nodeKey))
            );
        }
        return {
            keyToSourceKey(nodeKey) {
                return stringToNodeIdentifier(
                    nodeIdentifierToString(
                        requireNodeIdentifierForKey(
                            lookup,
                            stringToNodeKeyString(String(nodeKey))
                        )
                    )
                );
            },
            keyToOutputKey(nodeKey) {
                const semanticNodeKey = stringToNodeKeyString(String(nodeKey));
                const allocatedIdentifier = allocateNodeIdentifier(
                    lookup,
                    semanticNodeKey,
                    (attempt) => deterministicNodeIdentifierFromNodeKey(semanticNodeKey, attempt)
                );
                decisionKeyByOutputKey.set(String(allocatedIdentifier), nodeKey);
                return stringToNodeIdentifier(nodeIdentifierToString(allocatedIdentifier));
            },
            outputKeyToDecisionKey(outputKey) {
                return decisionKeyByOutputKey.get(String(outputKey))
                    ?? legacyStringToNodeIdentifier(
                        String(requireNodeKeyForIdentifier(
                            lookup,
                            nodeIdentifierFromString(String(outputKey))
                        ))
                    );
            },
            get outputEntries() {
                return serializeIdentifierLookup(lookup);
            },
        };
    }

    /** @type {Array<[import('./database/types').NodeIdentifier, NodeKeyString]>} */
    const initialOutputEntries = [];
    /** @type {Map<string, NodeIdentifier>} */
    const decisionKeyByOutputKey = new Map();
    for (const nodeKey of materializedNodes) {
        const canonicalKey = canonicalizeMigrationNodeKey(nodeKey);
        const nodeIdentifier = deterministicNodeIdentifierFromNodeKey(canonicalKey);
        const outputKey = stringToNodeIdentifier(nodeIdentifierToString(nodeIdentifier));
        initialOutputEntries.push([nodeIdentifier, canonicalKey]);
        decisionKeyByOutputKey.set(String(outputKey), nodeKey);
    }
    const legacyLookup = makeIdentifierLookup(initialOutputEntries);
    return {
        keyToSourceKey(nodeKey) {
            return nodeKey;
        },
        keyToOutputKey(nodeKey) {
            const canonicalKey = canonicalizeMigrationNodeKey(nodeKey);
            const allocatedIdentifier = allocateNodeIdentifier(
                legacyLookup,
                canonicalKey,
                (attempt) => deterministicNodeIdentifierFromNodeKey(canonicalKey, attempt)
            );
            const outputKey = stringToNodeIdentifier(nodeIdentifierToString(allocatedIdentifier));
            decisionKeyByOutputKey.set(String(outputKey), nodeKey);
            return outputKey;
        },
        outputKeyToDecisionKey(outputKey) {
            return decisionKeyByOutputKey.get(String(outputKey)) ?? legacyStringToNodeIdentifier(String(outputKey));
        },
        get outputEntries() {
            return serializeIdentifierLookup(legacyLookup);
        },
    };
}

/**
 * Wrap previous storage so migration callbacks can keep operating on semantic
 * node keys even when the persisted replica is already identifier-native.
 * @param {SchemaStorage} prevStorage
 * @param {{
 *   keyToSourceKey: (nodeKey: NodeIdentifier) => NodeIdentifier,
 *   keyToOutputKey: (nodeKey: NodeIdentifier) => NodeIdentifier,
 *   outputKeyToDecisionKey: (outputKey: NodeIdentifier) => NodeIdentifier,
 * }} keyPlan
 * @returns {ReadableMigrationStorage}
 */
function makeMigrationDecisionStorage(prevStorage, keyPlan) {
    /**
     * @template TValue
     * @param {{ get(key: NodeIdentifier): Promise<TValue | undefined> }} database
     * @returns {{ get(key: NodeIdentifier): Promise<TValue | undefined> }}
     */
    function makeSimpleDatabase(database) {
        return {
            async get(key) {
                return await database.get(keyPlan.keyToSourceKey(key));
            },
        };
    }

    return {
        values: makeSimpleDatabase(prevStorage.values),
        freshness: makeSimpleDatabase(prevStorage.freshness),
        inputs: {
            async get(key) {
                const record = await prevStorage.inputs.get(keyPlan.keyToSourceKey(key));
                if (record === undefined) {
                    return undefined;
                }
                return {
                    inputs: record.inputs.map((input) =>
                        String(keyPlan.outputKeyToDecisionKey(legacyStringToNodeIdentifier(input)))
                    ),
                    inputCounters: record.inputCounters,
                };
            },
        },
        revdeps: {
            async get(key) {
                const dependents = await prevStorage.revdeps.get(keyPlan.keyToSourceKey(key));
                if (dependents === undefined) {
                    return undefined;
                }
                return dependents.map((dependent) =>
                    keyPlan.outputKeyToDecisionKey(dependent)
                );
            },
        },
        counters: makeSimpleDatabase(prevStorage.counters),
        timestamps: makeSimpleDatabase(prevStorage.timestamps),
        global: prevStorage.global,
        batch: prevStorage.batch,
    };
}

/**
 * Build the desired revdeps map from decisions, reading inputs from prevStorage.
 *
 * Memory: O(|keys|) — only stores key strings in the result map; no large
 * values are retained.  Reads from prevStorage are streaming (one InputsRecord
 * at a time).
 *
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {{ keyToOutputKey: (nodeKey: NodeIdentifier) => NodeIdentifier }} keyPlan
 * @returns {Promise<Map<NodeIdentifier, NodeIdentifier[]>>}
 */
async function buildDesiredRevdeps(prevStorage, decisions, keyPlan) {
    /** @type {Map<string, Set<NodeIdentifier>>} */
    const revdepSets = new Map();

    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "delete" || decision.kind === "create") continue;

        const inputsRecord = await prevStorage.inputs.get(nodeKey);
        if (!inputsRecord) continue;

        for (const inputStr of inputsRecord.inputs) {
            const inputKey = legacyStringToNodeIdentifier(inputStr);
            const inputDecision = decisions.get(inputKey);
            if (inputDecision && inputDecision.kind === "delete") continue;
            const outputInputKey = keyPlan.keyToOutputKey(inputKey);
            const outputNodeKey = keyPlan.keyToOutputKey(nodeKey);
            const existing = revdepSets.get(String(outputInputKey));
            if (existing) {
                existing.add(outputNodeKey);
            } else {
                revdepSets.set(String(outputInputKey), new Set([outputNodeKey]));
            }
        }
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const result = new Map();
    for (const [inputStr, depSet] of revdepSets) {
        const inputKey = stringToNodeIdentifier(inputStr);
        result.set(inputKey, [...depSet].sort(compareNodeIdentifier));
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
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} desiredRevdeps
 * @param {import('./database/types').Version} newVersion
 * @param {{
 *   keyToOutputKey: (nodeKey: NodeIdentifier) => NodeIdentifier,
 *   outputKeyToDecisionKey: (outputKey: NodeIdentifier) => NodeIdentifier,
 *   outputEntries: Array<[import('./database/types').NodeIdentifier, NodeKeyString]>,
 * }} keyPlan
 * @returns {ReadableSchemaStorage}
 */
function makeLazyMigrationSource(prevStorage, decisions, desiredRevdeps, newVersion, keyPlan) {
    /** @type {Map<string, NodeIdentifier>} */
    const decisionKeyByOutputKey = new Map();
    for (const [nodeKey, decision] of decisions.entries()) {
        if (decision.kind === "delete") {
            continue;
        }
        const outputKey = keyPlan.keyToOutputKey(nodeKey);
        decisionKeyByOutputKey.set(String(outputKey), nodeKey);
    }

    const sortedDecisionOutputKeys = [...decisionKeyByOutputKey.keys()]
        .map((outputKeyString) => stringToNodeIdentifier(outputKeyString))
        .sort(compareNodeIdentifier);

    /**
     * Resolve migration output key back to the corresponding decision key.
     * Prefers the locally built map to preserve decision-key identity.
     * Falls back to keyPlan mapping for keys that are not represented in the
     * non-delete decision map.
     * @param {NodeIdentifier} outputKey
     * @returns {NodeIdentifier}
     */
    function resolveDecisionKey(outputKey) {
        return decisionKeyByOutputKey.get(String(outputKey))
            ?? keyPlan.outputKeyToDecisionKey(outputKey);
    }

    const sortedRevdepKeys = [...desiredRevdeps.keys()].sort();

    return {
        values: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decisionKey = resolveDecisionKey(outputKey);
                    const decision = decisions.get(decisionKey);
                    if (!decision) continue;
                    if (decision.kind === "create" || decision.kind === "override") {
                        yield outputKey;
                    } else if (decision.kind === "keep") {
                        const v = await prevStorage.values.get(decisionKey);
                        if (v !== undefined) yield outputKey;
                    }
                    // 'invalidate': no value in values sublevel
                }
            },
            async get(/** @type {NodeIdentifier} */ key) {
                const decisionKey = resolveDecisionKey(key);
                const decision = decisions.get(decisionKey);
                if (!decision) return undefined;
                if (decision.kind === "create" || decision.kind === "override") {
                    return await decision.value(decisionKey);
                }
                return await prevStorage.values.get(decisionKey);
            },
        },
        freshness: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decisionKey = resolveDecisionKey(outputKey);
                    const decision = decisions.get(decisionKey);
                    if (!decision) continue;
                    if (decision.kind === "create" || decision.kind === "override" || decision.kind === "invalidate") {
                        yield outputKey;
                    } else if (decision.kind === "keep") {
                        const f = await prevStorage.freshness.get(decisionKey);
                        if (f !== undefined) yield outputKey;
                    }
                }
            },
            async get(/** @type {NodeIdentifier} */ key) {
                const decisionKey = resolveDecisionKey(key);
                const decision = decisions.get(decisionKey);
                if (!decision) return undefined;
                if (decision.kind === "create" || decision.kind === "override") return "up-to-date";
                if (decision.kind === "invalidate") return "potentially-outdated";
                return await prevStorage.freshness.get(decisionKey);
            },
        },
        inputs: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decisionKey = resolveDecisionKey(outputKey);
                    const decision = decisions.get(decisionKey);
                    if (!decision) continue;
                    if (decision.kind === "create") {
                        yield outputKey;
                    } else {
                        const ir = await prevStorage.inputs.get(decisionKey);
                        if (ir !== undefined) yield outputKey;
                    }
                }
            },
            async get(/** @type {NodeIdentifier} */ key) {
                const decisionKey = resolveDecisionKey(key);
                const decision = decisions.get(decisionKey);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") return { inputs: [], inputCounters: [] };
                const record = await prevStorage.inputs.get(decisionKey);
                if (record === undefined) {
                    return undefined;
                }
                return {
                    inputs: record.inputs.map((input) =>
                        String(keyPlan.keyToOutputKey(legacyStringToNodeIdentifier(input)))
                    ),
                    inputCounters: record.inputCounters,
                };
            },
        },
        revdeps: {
            async *keys() {
                for (const key of sortedRevdepKeys) {
                    yield key;
                }
            },
            async get(/** @type {NodeIdentifier} */ key) {
                return desiredRevdeps.get(key);
            },
        },
        counters: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decisionKey = resolveDecisionKey(outputKey);
                    const decision = decisions.get(decisionKey);
                    if (!decision) continue;
                    if (decision.kind === "create" || decision.kind === "override") {
                        yield outputKey;
                    } else {
                        const c = await prevStorage.counters.get(decisionKey);
                        if (c !== undefined) yield outputKey;
                    }
                }
            },
            async get(/** @type {NodeIdentifier} */ key) {
                const decisionKey = resolveDecisionKey(key);
                const decision = decisions.get(decisionKey);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") return 1;
                if (decision.kind === "override") {
                    const prev = await prevStorage.counters.get(decisionKey);
                    return prev !== undefined ? prev + 1 : 1;
                }
                return await prevStorage.counters.get(decisionKey);
            },
        },
        timestamps: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decisionKey = resolveDecisionKey(outputKey);
                    const decision = decisions.get(decisionKey);
                    if (!decision) continue;
                    if (decision.kind === "create") continue;
                    const ts = await prevStorage.timestamps.get(decisionKey);
                    if (ts !== undefined) yield outputKey;
                }
            },
            async get(/** @type {NodeIdentifier} */ key) {
                const decisionKey = resolveDecisionKey(key);
                const decision = decisions.get(decisionKey);
                if (!decision || decision.kind === "delete" || decision.kind === "create") return undefined;
                return await prevStorage.timestamps.get(decisionKey);
            },
        },
        global: {
            async *keys() {
                yield 'version';
                yield IDENTIFIERS_KEY;
            },
            async get(/** @type {string} */ key) {
                if (key === IDENTIFIERS_KEY) {
                    return keyPlan.outputEntries;
                }
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
 * @returns {Promise<RootDatabase>}
 */
async function runMigration(capabilities, rootDatabase, nodeDefs, callback) {
    return await withExclusiveMode(capabilities.sleeper, async () => {
        return await runMigrationUnsafe(capabilities, rootDatabase, nodeDefs, callback);
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
 * @returns {Promise<RootDatabase>}
 */
async function runMigrationUnsafe(capabilities, rootDatabase, nodeDefs, callback)
{
    const currentVersion = rootDatabase.version;
    const activeReplica = rootDatabase.currentReplicaName();
    const inactiveReplica = rootDatabase.otherReplicaName();

    capabilities.logger.logDebug(
        {
            currentVersion,
            activeReplica,
            inactiveReplica,
            nodeDefinitionCount: nodeDefs.length,
        },
        'Migration check: evaluating whether migration is required'
    );

    /** @type {Version | undefined} */
    const prevVersion = await rootDatabase.getGlobalVersion();
    if (prevVersion === undefined) {
        capabilities.logger.logDebug(
            { currentVersion, activeReplica },
            'Migration not required: no stored version found in active replica; marking fresh database with current version'
        );
        // No previous version recorded; fresh database: record current version, nothing to migrate.
        await rootDatabase.setGlobalVersion(rootDatabase.version);
        return rootDatabase;
    }

    if (prevVersion === currentVersion) {
        capabilities.logger.logDebug(
            { prevVersion, currentVersion, activeReplica },
            'Migration not required: stored version already matches current application version'
        );
        // Already on the current version.
        return rootDatabase;
    }

    capabilities.logger.logDebug(
        { prevVersion, currentVersion, fromReplica: activeReplica, toReplica: inactiveReplica },
        'Migration required: stored version differs from current version; preparing replica cutover migration'
    );

    capabilities.logger.logInfo({
        prevVersion, currentVersion
    }, `Starting migration from ${String(prevVersion)} to ${String(currentVersion)}`);

    let switchedReplica = false;
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
            const keyPlan = await makeMigrationKeyPlan(prevStorage, materializedNodes);
            const decisionNodes = materializedNodes.map((nodeKey) =>
                keyPlan.outputKeyToDecisionKey(nodeKey)
            );
            const decisionStorage = makeMigrationDecisionStorage(prevStorage, keyPlan);

            // Create the MigrationStorage for the user callback.
            const migrationStorage = makeMigrationStorage(
                decisionStorage,
                newHeadIndex,
                decisionNodes
            );

            // Execute user migration callback.
            await callback(migrationStorage);

            // Finalize: propagate deletes, check fan-in, check completeness.
            const decisions = await migrationStorage.finalize();

            const toStorage = rootDatabase.schemaStorageForReplica(toReplica);

            // Build the desired revdeps map.  Reads inputs from prevStorage once
            // per non-create/non-delete node; stores only key strings, O(|keys|) mem.
            const desiredRevdeps = await buildDesiredRevdeps(
                decisionStorage,
                decisions,
                keyPlan
            );

            // Create a lazy source that computes desired values on demand.
            // Combined with makeDbToDbAdapter + unifyStores this keeps peak
            // memory at O(|max value| + |keys|), matching the sync path.
            const lazySource = makeLazyMigrationSource(
                decisionStorage,
                decisions,
                desiredRevdeps,
                currentVersion,
                keyPlan
            );

            // Gently unify the desired state into the target replica.
            // Only changed keys are written; stale keys are deleted first.
            // The new version is included in the lazy source's global sublevel,
            // so it is written atomically with the data — no separate version write.
            await unifyStores(makeDbToDbAdapter(lazySource, toStorage));
            // One final fsync: all unification writes use sync:false for performance;
            // _rawSync() issues an empty batch with sync:true to flush the WAL
            // without rewriting any keys.
            await rootDatabase._rawSync();

            // Persist the new active replica pointer after all writes succeed.
            await rootDatabase.setCurrentReplicaPointer(toReplica);
            switchedReplica = true;
        }
    );

    if (switchedReplica && typeof rootDatabase.close === 'function') {
        await rootDatabase.close();
        const rebuiltDatabase = await getRootDatabase(capabilities);
        capabilities.logger.logDebug(
            { activeReplica: rebuiltDatabase.currentReplicaName() },
            'Migration cutover completed with rebuilt root database'
        );
        return rebuiltDatabase;
    }

    capabilities.logger.logInfo({
        prevVersion, currentVersion
    }, `Migration from ${String(prevVersion)} to ${String(currentVersion)} completed successfully.`);
    return rootDatabase;
}

module.exports = {
    runMigration,
    runMigrationUnsafe,
};
