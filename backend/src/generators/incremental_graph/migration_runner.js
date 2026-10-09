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
const { holidayActivity } = require("./lock");
const { makeMigrationStorage } = require("./migration_storage");
const {
    isJournalFormatCodec,
    makeIdentityJournalFormatCodec,
} = require("./migration_codec");
const { makeHistoryRewriter } = require("./journal_rewrite");
const { makeTargetKeyView } = require("./migration_target_keys");
const { buildDecisionsMap, buildTargetValidity, loadMaterializedNodes } = require("./migration_validity");
const { tryUnsupportedPersistedIdentifier } = require("./migration_source_domain");
const { buildMigrationM1Intents } = require("./migration_m1");
const { buildProducedOccurrences } = require("./migration_occurrences");
const { buildMigrationJournal } = require("./migration_journal");
const { verifyTargetReplica } = require("./migration_verification");
const { makeLazyMigrationSource } = require("./migration_source");
const { makeJournalAuthor } = require("./journal");
const { readCurrentOccurrence } = require("./journal_store");
const { checkpointMigration } = require("./database");
const { unifyStores, makeDbToDbAdapter, deserializeNodeKey } = require("./database");
const { fromISOString } = require("../../datetime");

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
/** @typedef {import('./migration_codec').JournalFormatCodec} JournalFormatCodec */

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
}

/**
 * Run a database migration.
 *
 * The callback receives a MigrationStorage instance and must assign exactly one
 * decision (keep / replace / invalidate / delete) to every node materialized in
 * the previous application version.  Propagation rules and completeness are
 * enforced automatically; any violation throws before the new version is written.
 *
 * `codec` is the migration definition's directed source->target
 * `JournalFormatCodec`, which `incremental-graph-journal-migrations.md` §9a makes the
 * one representation-rewrite mechanism of the transition. It rewrites the retained
 * history the target carries while the callback decides the semantic target graph.
 * §9a defaults an omitted transform to the identity transform, and the identity codec
 * is the declaration of a transition whose retained history already is target-format.
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
 * @param {JournalFormatCodec} [codec] - The transition's source->target Journal format
 *   codec, which defaults to the identity codec.
 * @returns {Promise<RootDatabase>}
 */
async function runMigration(capabilities, rootDatabase, nodeDefs, callback, codec) {
    return await holidayActivity(capabilities.sleeper, async () => {
        return await runMigrationUnsafe(capabilities, rootDatabase, nodeDefs, callback, codec);
    });
}

/**
 * @typedef {import('./types').Version} Version
 */

/**
 * The predicate which tells a migration whether converted history names a value
 * occurrence of a node key.
 *
 * M1's occurrence-preserving rule — a `keep` or an `invalidate` authors no
 * `ValueEvent`, because the transported occurrence keeps the `ValueId` converted
 * history already gave it — holds exactly when the source replica's retained Journal
 * names that occurrence. A source replica whose retained history predates the Journal
 * names none, and every occurrence-preserving decision against it transports a value
 * no record describes.
 *
 * The predicate reads the source replica's own occurrence index, which is the same
 * read the ordinary publication path makes when a certificate names an input
 * occurrence, so the migration decides M1 on the same fact a later pull would.
 *
 * @param {SchemaStorage} prevStorage - The still-active source replica.
 * @returns {(nodeKeyString: NodeKeyString) => Promise<boolean>}
 */
function makeOccurrenceNamer(prevStorage) {
    return async (nodeKeyString) => {
        const occurrence = await readCurrentOccurrence(
            prevStorage.journal,
            deserializeNodeKey(nodeKeyString)
        );
        if (occurrence instanceof Error) {
            throw occurrence;
        }
        return occurrence !== undefined;
    };
}

/**
 * The unlocked version of runMigration. Should not be called directly.
 *
 * @param {Capabilities} capabilities - Capabilities needed to run the migration
 * @param {RootDatabase} rootDatabase - Opened root database
 * @param {Array<NodeDef>} nodeDefs - New-version schema node definitions
 * @param {(storage: MigrationStorage) => Promise<void>} callback
 * @param {JournalFormatCodec} [codec] - The transition's source->target Journal format
 *   codec, which defaults to the identity codec.
 * @returns {Promise<RootDatabase>}
 */
async function runMigrationUnsafe(capabilities, rootDatabase, nodeDefs, callback, codec)
{
    const currentVersion = rootDatabase.getVersion();
    const activeReplica = rootDatabase.currentReplicaName();
    const inactiveReplica = rootDatabase.otherReplicaName();
    const journalFormatCodec = codec ?? makeIdentityJournalFormatCodec();
    if (isJournalFormatCodec(journalFormatCodec) !== true) {
        throw new Error(
            "runMigration: the journal format codec must be built by makeJournalFormatCodec"
        );
    }

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

            // Every identifier of this replica is transported into the target
            // unchanged, so a source persisting one outside the supported
            // NodeIdentifier domain is not a supported migration source. It is
            // rejected here, before the callback runs and before the target
            // replica is written, rather than leaving a target behind which
            // materializes nodes no Journal record can name.
            const unsupportedIdentifier = tryUnsupportedPersistedIdentifier(
                oldLookup,
                `migration source replica (${fromReplica})`
            );
            if (unsupportedIdentifier !== undefined) {
                throw unsupportedIdentifier;
            }

            await assertValidReplicaMaterializationState(
                prevStorage,
                oldLookup,
                `migration source replica (${fromReplica})`
            );

            // §9a's rewrite and §11's callback key space both address the source
            // materialization in target NodeKey representation, so the transition's
            // codec builds the one rewriter which serves both halves: the retained
            // history the target carries, and the target-key view the callback reasons
            // in. A rewrite which is not total over this replica's materialized set
            // fails here, before the callback runs and before the target is written.
            const rewriter = makeHistoryRewriter(journalFormatCodec);
            const targetKeyView = makeTargetKeyView(oldLookup, rewriter);
            if (targetKeyView instanceof Error) {
                throw targetKeyView;
            }

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
                oldLookup,
                targetKeyView
            );

            // Execute user migration callback.
            await callback(migrationStorage);

            // Finalize: propagate deletes, check fan-in, check completeness.
            const decisions = await migrationStorage.finalize();

            const toStorage = rootDatabase.schemaStorageForReplica(toReplica);

            // The target replica materializes the transported target keys, so its
            // identifier lookup is the source materialization under the target
            // representation rather than the source spelling of it.
            const finalLookup = parseIdentifierLookup(
                buildDecisionsMap(targetKeyView, decisions),
                'migration target replica'
            );

            // §11a.4 fixes the target's validity edges and its freshness flags
            // together in dependency-topological order: a decision's freshness names
            // the freshness of the inputs it selected, so those inputs are settled
            // before it, and a `create`'s up-to-date assertion reads their flags.
            const { desiredValid, targetFreshness } = await buildTargetValidity(
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
            // The migration publication instant, which §11a.3 makes the `modifiedAt` of
            // every genuinely produced occurrence and the seed of every M1 authority.
            const publicationInstant = capabilities.datetime.now().toISOString();
            const producedOccurrences = await buildProducedOccurrences(
                decisions,
                prevStorage,
                oldLookup,
                targetKeyView,
                publicationInstant,
                makeOccurrenceNamer(prevStorage),
                rewriter
            );

            const lazySource = makeLazyMigrationSource(
                prevStorage,
                oldLookup,
                decisions,
                desiredValid,
                targetFreshness,
                currentVersion,
                migrationStorage.getMaxAllocatedIndex(),
                sourceLastNodeIndex,
                rootDatabase.getFingerprint(),
                graphSchemeString,
                producedOccurrences,
                finalLookup,
                rewriter
            );

            // Gently unify the desired state into the target replica.
            // Only changed keys are written; stale keys are deleted first.
            // The new version is included in the lazy source's global sublevel,
            // so it is written atomically with the data — no separate version write.
            await unifyStores(makeDbToDbAdapter(lazySource, toStorage));

            // Build the target's Journal before the cutover. The graph state just
            // unified is a projection of this history, so a target which received
            // values without the history explaining them has nodes with no value
            // occurrence to validate against and the first ordinary publication after
            // the cutover fails.
            const migrationIntents = buildMigrationM1Intents(
                decisions,
                targetKeyView,
                producedOccurrences,
                /**
                 * @param {NodeKeyString} nodeKeyString
                 * @returns {import('./database/node_key').NodeKey}
                 */
                (nodeKeyString) => deserializeNodeKey(nodeKeyString)
            );
            await buildMigrationJournal(
                prevStorage,
                toStorage,
                rootDatabase.getFingerprint(),
                migrationIntents,
                fromISOString(publicationInstant).toMillis(),
                Math.max(sourceLastNodeIndex, migrationStorage.getMaxAllocatedIndex()),
                rewriter
            );

            // One final fsync: all unification writes use sync:false for performance;
            // _rawSync() issues an empty batch with sync:true to flush the WAL
            // without rewriting any keys.
            await rootDatabase._rawSync();

            // §22 step 5. The target's graph state is a projection of the retained
            // history just carried into it plus the M1 records just appended, and
            // nothing else here reads the target's Journal, so the target is
            // replayed here and compared against the graph it persists. A cutover
            // which selected a target whose two representations disagreed would
            // otherwise report success over an inconsistent replica.
            //
            // §22 step 6. The one atomic cutover which selects the target. Everything
            // above wrote only the still-inactive target, so a failure anywhere above
            // leaves the previous active pair selected.

            // Validate the target replica before activating it.
            // This checks the invariant: every up-to-date node has valid flags
            // for every input, and no valid entries reference unknown identifiers.
            const rawIdentifiers = await toStorage.global.get(IDENTIFIERS_KEY);
            if (rawIdentifiers === undefined) {
                throw new MissingIdentifierLookupError('migration target replica');
            }
            const targetLookup = parseIdentifierLookup(rawIdentifiers, 'migration target replica');
            await assertValidReplicaMaterializationState(toStorage, targetLookup, 'migration target replica');
            const localWriter = makeJournalAuthor(rootDatabase.getFingerprint());
            if (localWriter instanceof Error) {
                throw localWriter;
            }
            await verifyTargetReplica(
                toStorage,
                targetLookup,
                newGraphScheme,
                localWriter,
                toReplica
            );

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
