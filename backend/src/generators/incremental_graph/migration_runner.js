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
    compareNodeIdentifier,
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    nodeIdentifierToString,
    stringToNodeIdentifier,
    stringToNodeKeyString,
    makeEmptyIdentifierLookup,
    parseIdentifierLookup,
    assertValidFinalMergeState,
    buildGraphSchemeFromNodeDefs,
    serializeGraphScheme,
    parseGraphScheme,
    deriveInputEdges,
    GRAPH_SCHEME_KEY,
    MissingGraphSchemeError,
} = require("./database");
const { holidayActivity } = require("./lock");
const { makeMigrationStorage } = require("./migration_storage");
const { checkpointMigration } = require("./database");
const { unifyStores, makeDbToDbAdapter } = require("./database");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Freshness} Freshness */
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
    for await (const key of storage.values.keys()) {
        nodes.push(key);
    }
    return nodes;
}



/**
 * Add a dependent to a validity set, maintaining deduplication.
 * @param {Map<string, Set<NodeIdentifier>>} validSets
 * @param {NodeIdentifier} input
 * @param {NodeIdentifier} dependent
 */
function addToValidSet(validSets, input, dependent) {
    const inputString = nodeIdentifierToString(input);
    const dependents = validSets.get(inputString) ?? new Set();
    dependents.add(dependent);
    validSets.set(inputString, dependents);
}

/**
 * Build the identifiers_keys_map that reflects all decisions.
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @returns {Promise<Array<[NodeIdentifier, NodeKeyString]>>}
 */
async function buildDecisionsMap(prevStorage, decisions) {
    const oldEntries = await prevStorage.global.get(IDENTIFIERS_KEY);

    /** @type {Map<string, NodeKeyString>} */
    const idToKey = new Map();
    if (Array.isArray(oldEntries)) {
        for (const [id, nodeKeyJson] of oldEntries) {
            const decision = decisions.get(stringToNodeIdentifier(String(id)));
            if (!decision || decision.kind !== "delete") {
                idToKey.set(String(id), stringToNodeKeyString(String(nodeKeyJson)));
            }
        }
    }

    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "create" && decision.nodeKeyString !== undefined) {
            idToKey.set(nodeIdentifierToString(nodeKey), stringToNodeKeyString(decision.nodeKeyString));
        }
    }

    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const [id, key] of idToKey.entries()) {
        entries.push([stringToNodeIdentifier(id), key]);
    }
    entries.sort(([leftId], [rightId]) => compareNodeIdentifier(leftId, rightId));
    return entries;
}

/**
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @returns {Set<string>}
 */
function materializedDecisionStrings(decisions) {
    const result = new Set();
    for (const [identifier, decision] of decisions) {
        if (decision.kind !== "delete") {
            result.add(nodeIdentifierToString(identifier));
        }
    }
    return result;
}

/**
 * Build validity sets from migration decisions and scheme-derived final edges.
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {import('./database/graph_scheme').GraphScheme} oldScheme
 * @param {import('./database/graph_scheme').GraphScheme} newScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @param {import('./database/identifier_lookup').IdentifierLookup} finalLookup
 * @returns {Promise<Map<NodeIdentifier, NodeIdentifier[]>>}
 */
async function buildDesiredValid(prevStorage, decisions, oldScheme, newScheme, oldLookup, finalLookup) {
    /** @type {Map<string, Set<NodeIdentifier>>} */
    const validSets = new Map();
    const materialized = materializedDecisionStrings(decisions);

    for (const [nodeIdentifier, decision] of decisions) {
        if (decision.kind === "delete" || decision.kind === "invalidate") continue;
        const finalEdges = deriveInputEdges(newScheme, finalLookup, nodeIdentifier);
        for (const edge of finalEdges) {
            if (!materialized.has(nodeIdentifierToString(edge))) {
                throw new Error(`Migration dependency ${nodeIdentifierToString(edge)} for ${nodeIdentifierToString(nodeIdentifier)} is not materialized in the target replica`);
            }
        }

        const finalFreshness = decision.kind === "keep"
            ? await prevStorage.freshness.get(nodeIdentifier)
            : "up-to-date";
        if (finalFreshness === "up-to-date") {
            for (const input of finalEdges) {
                addToValidSet(validSets, input, nodeIdentifier);
            }
            continue;
        }

        if (decision.kind !== "keep" || finalFreshness !== "potentially-outdated") continue;
        const oldEdges = deriveInputEdges(oldScheme, oldLookup, nodeIdentifier);
        for (const input of finalEdges) {
            const inputDecision = decisions.get(input);
            if (!inputDecision || inputDecision.kind !== "keep") continue;
            if (!oldEdges.some(edge => nodeIdentifierToString(edge) === nodeIdentifierToString(input))) continue;
            const existingValidForD = await prevStorage.valid.get(input) ?? [];
            if (existingValidForD.some(id => nodeIdentifierToString(id) === nodeIdentifierToString(nodeIdentifier))) {
                addToValidSet(validSets, input, nodeIdentifier);
            }
        }
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const result = new Map();
    for (const [inputString, dependents] of validSets) {
        result.set(stringToNodeIdentifier(inputString), [...dependents].sort(compareNodeIdentifier));
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
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} desiredValid
 * @param {import('./database/types').Version} newVersion
 * @param {import('../../datetime').Datetime} datetime - Datetime capability for generating timestamps.
 * @param {number} maxAllocatedIndex - The max allocated local index during this migration.
 * @param {string} fingerprint - The database fingerprint to carry forward.
 * @param {import('./database/graph_scheme').GraphScheme} graphScheme
 * @returns {ReadableSchemaStorage}
 */
function makeLazyMigrationSource(prevStorage, decisions, desiredValid, newVersion, datetime, maxAllocatedIndex, fingerprint, graphScheme) {
    const sortedDecisionOutputKeys = [...decisions.keys()]
        .sort(compareNodeIdentifier);

    const sortedValidKeys = [...desiredValid.keys()].sort(compareNodeIdentifier);

    return {
        values: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    if (decision.kind === "create" || decision.kind === "override") {
                        yield outputKey;
                    } else if (decision.kind === "keep" || decision.kind === "invalidate") {
                        const v = await prevStorage.values.get(outputKey);
                        if (v !== undefined) yield outputKey;
                    }
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create" || decision.kind === "override") {
                    return await decision.value(key);
                }
                return await prevStorage.values.get(key);
            },
        },
        freshness: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    if (decision.kind === "create" || decision.kind === "override" || decision.kind === "invalidate") {
                        yield outputKey;
                    } else if (decision.kind === "keep") {
                        const f = await prevStorage.freshness.get(outputKey);
                        if (f !== undefined) yield outputKey;
                    }
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create" || decision.kind === "override") return "up-to-date";
                if (decision.kind === "invalidate") return "potentially-outdated";
                return await prevStorage.freshness.get(key);
            },
        },
        valid: {
            async *keys() {
                for (const key of sortedValidKeys) {
                    yield key;
                }
            },
            async get(key) {
                return desiredValid.get(key);
            },
        },
        timestamps: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    if (decision.kind === "create") {
                        yield outputKey;
                        continue;
                    }
                    const ts = await prevStorage.timestamps.get(outputKey);
                    if (ts !== undefined) yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") {
                    const nowIso = datetime.now().toISOString();
                    return { createdAt: nowIso, modifiedAt: nowIso };
                }
                return await prevStorage.timestamps.get(key);
            },
        },
        global: {
            async *keys() {
                yield 'version';
                yield IDENTIFIERS_KEY;
                yield LAST_NODE_INDEX_KEY;
                yield 'fingerprint';
                yield GRAPH_SCHEME_KEY;
            },
            async get(key) {
                if (key === 'version') {
                    return newVersion;
                }
                if (key === IDENTIFIERS_KEY) {
                    return await buildDecisionsMap(prevStorage, decisions);
                }
                if (key === LAST_NODE_INDEX_KEY) {
                    const prevLastNodeIndex = await prevStorage.global.get(LAST_NODE_INDEX_KEY);
                    const prevValue = (typeof prevLastNodeIndex === 'number' && Number.isInteger(prevLastNodeIndex) && prevLastNodeIndex >= 0)
                        ? prevLastNodeIndex : 0;
                    return Math.max(prevValue, maxAllocatedIndex);
                }
                if (key === 'fingerprint') {
                    return fingerprint;
                }
                if (key === GRAPH_SCHEME_KEY) {
                    return JSON.stringify(graphScheme);
                }
                return await prevStorage.global.get(key);
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
    return await holidayActivity(capabilities.sleeper, async () => {
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
    const currentVersion = rootDatabase.getVersion();
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
        // No previous version recorded; fresh database: record current version
        // and graph_scheme, nothing to migrate.
        const compiledNodes = nodeDefs.map(compileNodeDef);
        const currentGraphScheme = JSON.stringify(
            serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes))
        );
        const schemaStorage = rootDatabase.getSchemaStorage();
        await schemaStorage.global.put(GRAPH_SCHEME_KEY, currentGraphScheme);
        await rootDatabase.setGlobalVersion(rootDatabase.getVersion());
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
            const newGraphScheme = serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes));
            const storedOldScheme = await prevStorage.global.get(GRAPH_SCHEME_KEY);
            if (storedOldScheme === undefined) {
                throw new MissingGraphSchemeError(
                    `migration source replica (${fromReplica})`
                );
            }
            const oldGraphScheme = parseGraphScheme(storedOldScheme);
            const rawOldIdentifiers = await prevStorage.global.get(IDENTIFIERS_KEY);
            const oldLookup = rawOldIdentifiers === undefined
                ? makeEmptyIdentifierLookup()
                : parseIdentifierLookup(rawOldIdentifiers, 'migration source replica');
            /** @type {Map<NodeName, CompiledNode>} */
            const newHeadIndex = new Map(compiledNodes.map((n) => [n.head, n]));

            // Load previous-version materialized nodes.
            const materializedNodes = await loadMaterializedNodes(prevStorage);

            // Create the MigrationStorage for the user callback.
            const migrationStorage = makeMigrationStorage(
                prevStorage,
                newHeadIndex,
                materializedNodes,
                rootDatabase.getFingerprint(),
                rootDatabase.getLastNodeIndex(),
                oldGraphScheme,
                newGraphScheme,
                oldLookup
            );

            // Execute user migration callback.
            await callback(migrationStorage);

            // Finalize: propagate deletes, check fan-in, check completeness.
            const decisions = await migrationStorage.finalize();

            const toStorage = rootDatabase.schemaStorageForReplica(toReplica);

            const finalLookup = parseIdentifierLookup(
                await buildDecisionsMap(prevStorage, decisions),
                'migration target replica'
            );

            const desiredValid = await buildDesiredValid(
                prevStorage,
                decisions,
                oldGraphScheme,
                newGraphScheme,
                oldLookup,
                finalLookup
            );

            // Create a lazy source that computes desired values on demand.
            // Combined with makeDbToDbAdapter + unifyStores this keeps peak
            // memory at O(|max value| + |keys|), matching the sync path.
            const lazySource = makeLazyMigrationSource(
                prevStorage,
                decisions,
                desiredValid,
                currentVersion,
                capabilities.datetime,
                migrationStorage.getMaxAllocatedIndex(),
                rootDatabase.getFingerprint(),
                newGraphScheme
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

            // Validate the target replica before activating it.
            // This checks the invariant: every up-to-date node has valid flags
            // for every input, and no valid entries reference unknown identifiers.
            const rawIdentifiers = await toStorage.global.get(IDENTIFIERS_KEY);
            const targetLookup = rawIdentifiers === undefined
                ? makeEmptyIdentifierLookup()
                : parseIdentifierLookup(rawIdentifiers, 'migration target replica');
            await assertValidFinalMergeState(toStorage, targetLookup);

            // Persist the new active replica pointer after all writes succeed.
            await rootDatabase.setCurrentReplicaPointer(toReplica);
        }
    );

    capabilities.logger.logInfo({
        prevVersion, currentVersion
    }, `Migration from ${String(prevVersion)} to ${String(currentVersion)} completed successfully.`);
    return rootDatabase;
}

module.exports = {
    runMigration,
    runMigrationUnsafe,
};
