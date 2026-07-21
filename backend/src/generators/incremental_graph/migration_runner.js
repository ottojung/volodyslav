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

const { compileValidatedGraphSchema } = require("./graph_schema");
const {
    compareNodeIdentifier,
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    MissingIdentifierLookupError,
    parseIdentifierLookup,
    assertValidReplicaMaterializationState,
    parseGraphScheme,
    GRAPH_SCHEME_KEY,
    GraphSchemeError,
    MissingGraphSchemeError,
} = require("./database");
const { makeInvalidMigrationDecisionError } = require("./migration_errors");
const { holidayActivity } = require("./lock");
const { makeMigrationStorage } = require("./migration_storage");
const { buildDecisionsMap, buildDesiredValid, loadMaterializedNodes } = require("./migration_validity");
const { checkpointMigration } = require("./database");
const { unifyStores, makeDbToDbAdapter } = require("./database");
const { incrementValueClock } = require("./database");

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
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} desiredValid
 * @param {import('./database/types').Version} newVersion
 * @param {import('../../datetime').Datetime} datetime - Datetime capability for generating timestamps.
 * @param {number} maxAllocatedIndex - The max allocated local index during this migration.
 * @param {number} sourceLastNodeIndex - The validated durable last_node_index from the source replica.
 * @param {string} fingerprint - The database fingerprint to carry forward.
 * @param {string} graphSchemeString
 * @returns {ReadableSchemaStorage}
 */
function makeLazyMigrationSource(prevStorage, oldLookup, decisions, desiredValid, newVersion, datetime, maxAllocatedIndex, sourceLastNodeIndex, fingerprint, graphSchemeString) {
    const producedValues = new Map();

    /**
     * @param {NodeIdentifier} key
     * @param {Decision} decision
     * @returns {Promise<ComputedValue | undefined>}
     */
    async function readFinalValue(key, decision) {
        if (decision.kind === "create" || decision.kind === "override") {
            const keyString = String(key);
            let valuePromise = producedValues.get(keyString);
            if (valuePromise === undefined) {
                valuePromise = decision.value(key);
                producedValues.set(keyString, valuePromise);
            }
            try {
                const value = await valuePromise;
                if (value === null || value === undefined) {
                    throw makeInvalidMigrationDecisionError(`Migration value producer for ${keyString} did not return a computed value`);
                }
                return value;
            } finally {
                producedValues.delete(keyString);
            }
        }
        return await prevStorage.values.get(key);
    }

    const sortedDecisionOutputKeys = [...decisions.keys()]
        .sort(compareNodeIdentifier);

    const sortedValidKeys = [...desiredValid.keys()].sort(compareNodeIdentifier);

    return {
        values: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                return await readFinalValue(key, decision);
            },
        },
        freshness: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") return decision.freshness;
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
                    yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                const existing = await prevStorage.timestamps.get(key);
                if (decision.kind === "create") {
                    const nowIso = datetime.now().toISOString();
                    return { createdAt: nowIso, modifiedAt: nowIso };
                }
                if (decision.kind === "invalidate" || decision.kind === "override" || decision.kind === "keep") {
                    return existing;
                }
                return existing;
            },
        },

        valueClocks: {
            keys: async function* keys() { for (const outputKey of sortedDecisionOutputKeys) { const decision = decisions.get(outputKey); if (decision && decision.kind !== "delete") yield outputKey; } },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                return decision.kind === "create" ? incrementValueClock(undefined, fingerprint) : await prevStorage.valueClocks.get(key);
            },
        },
        conflictFrontiers: { keys: async function* keys() {}, async get(_key) { return undefined; } },
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
                    return buildDecisionsMap(oldLookup, decisions);
                }
                if (key === LAST_NODE_INDEX_KEY) {
                    return Math.max(sourceLastNodeIndex, maxAllocatedIndex);
                }
                if (key === 'fingerprint') {
                    return fingerprint;
                }
                if (key === GRAPH_SCHEME_KEY) {
                    return graphSchemeString;
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
            'Migration not required: no stored version found in active replica; database initialization is handled by prepareIncrementalGraphStorage'
        );
        // No previous version recorded; database is uninitialized.
        // Fresh database initialization is owned by prepareIncrementalGraphStorage,
        // which writes global/version and global/graph_scheme together.
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

            // Compile and validate the new schema through the shared helper.
            const validated = compileValidatedGraphSchema(nodeDefs);
            const { headIndex: newHeadIndex, graphScheme: newGraphScheme, graphSchemeString } = validated;

            const storedOldScheme = await prevStorage.global.get(GRAPH_SCHEME_KEY);
            if (storedOldScheme === undefined) {
                throw new MissingGraphSchemeError(
                    `migration source replica (${fromReplica})`
                );
            }
            if (typeof storedOldScheme !== "string") {
                throw new GraphSchemeError(
                    `Invalid graph_scheme in migration source replica (${fromReplica}): expected string`
                );
            }
            const oldGraphScheme = parseGraphScheme(storedOldScheme);

            // Strict source lookup loading: initialized replicas must have
            // a valid identifiers_keys_map. An undefined or malformed lookup
            // is rejected immediately.
            const rawOldIdentifiers = await prevStorage.global.get(IDENTIFIERS_KEY);
            if (rawOldIdentifiers === undefined) {
                throw new MissingIdentifierLookupError(
                    `migration source replica (${fromReplica})`
                );
            }
            const oldLookup = parseIdentifierLookup(
                rawOldIdentifiers,
                `migration source replica (${fromReplica})`
            );

            await assertValidReplicaMaterializationState(
                prevStorage,
                oldLookup,
                `migration source replica (${fromReplica})`
            );

            // Load previous-version materialized nodes.
            const materializedNodes = loadMaterializedNodes(oldLookup);

            // Validate source last_node_index: every initialized replica
            // must have a valid durable last_node_index.
            const rawSourceLastNodeIndex = await prevStorage.global.get(LAST_NODE_INDEX_KEY);
            if (typeof rawSourceLastNodeIndex !== 'number'
                || !Number.isInteger(rawSourceLastNodeIndex)
                || rawSourceLastNodeIndex < 0) {
                throw new MissingIdentifierLookupError(
                    `migration source replica (${fromReplica}) has a version but missing or invalid last_node_index`
                );
            }
            const sourceLastNodeIndex = rawSourceLastNodeIndex;

            // Create the MigrationStorage for the user callback.
            const migrationStorage = makeMigrationStorage(
                prevStorage,
                newHeadIndex,
                materializedNodes,
                rootDatabase.getFingerprint(),
                sourceLastNodeIndex,
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
                buildDecisionsMap(oldLookup, decisions),
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
                oldLookup,
                decisions,
                desiredValid,
                currentVersion,
                capabilities.datetime,
                migrationStorage.getMaxAllocatedIndex(),
                sourceLastNodeIndex,
                rootDatabase.getFingerprint(),
                graphSchemeString
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
            if (rawIdentifiers === undefined) {
                throw new MissingIdentifierLookupError('migration target replica');
            }
            const targetLookup = parseIdentifierLookup(rawIdentifiers, 'migration target replica');
            await assertValidReplicaMaterializationState(toStorage, targetLookup, 'migration target replica');

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
