/**
 * Lifecycle operations for the generators interface.
 */

/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../incremental_graph/types').NodeDef} NodeDef */
/** @typedef {import('../incremental_graph/migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */
/**
 * @typedef {object} InterfaceLifecycleAccess
 * @property {() => GeneratorsCapabilities} _getCapabilities
 * @property {import('../incremental_graph').IncrementalGraph | null} _incrementalGraph
 * @property {RootDatabase | null} _database
 * @property {import('../individual/all_events/wrapper').AllEventsBox | null} _allEventsBox
 * @property {import('../individual/config/wrapper').ConfigBox | null} _configBox
 * @property {import('../individual/diary_most_important_info_summary/wrapper').DiarySummaryBox | null} _diarySummaryBox
 * @property {import('../individual/ontology/wrapper').OntologyBox | null} _ontologyBox
 */

const {
    makeIncrementalGraph,
    getRootDatabase,
    runMigrationUnsafe,
    synchronizeNoLock,
    withExclusiveMode,
    migrationCallback,
} = require("../incremental_graph");
const { createDefaultGraphDefinition } = require("./default_graph");
const { makeSynchronizeDatabaseError } = require("./errors");
const { allEvents, config, diarySummary, ontology } = require("../individual");

/** @param {InterfaceLifecycleAccess} interfaceInstance */
function internalIsInitialized(interfaceInstance) {
    return interfaceInstance._incrementalGraph !== null;
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @returns {import('../incremental_graph').IncrementalGraph}
 */
function internalRequireInitializedGraph(interfaceInstance) {
    if (interfaceInstance._incrementalGraph === null) {
        throw new Error("Impossible: expected non-null");
    }
    return interfaceInstance._incrementalGraph;
}

/** @param {InterfaceLifecycleAccess} interfaceInstance */
async function internalEnsureInitialized(interfaceInstance) {
    if (interfaceInstance._incrementalGraph !== null) {
        return;
    }
    const capabilities = interfaceInstance._getCapabilities();
    await withExclusiveMode(capabilities.sleeper, async () => {
        await internalEnsureInitializedWithMigration(interfaceInstance, runMigrationUnsafe);
    });
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {(capabilities: GeneratorsCapabilities, database: RootDatabase, nodeDefs: Array<NodeDef>, callback: (storage: MigrationStorage) => Promise<void>) => Promise<void>} runMigrationProcedure
 * @returns {Promise<void>}
 */
async function internalEnsureInitializedWithMigration(
    interfaceInstance,
    runMigrationProcedure
) {
    if (interfaceInstance._incrementalGraph !== null) {
        return;
    }

    const capabilities = interfaceInstance._getCapabilities();
    const database = await getRootDatabase(capabilities);
    const configBox = config.makeBox();
    const allEventsBox = allEvents.makeBox();
    const diarySummaryBox = diarySummary.makeBox();
    const ontologyBox = ontology.makeBox();
    const nodeDefs = createDefaultGraphDefinition(
        capabilities,
        configBox,
        allEventsBox,
        diarySummaryBox,
        ontologyBox
    );
    try {
        await runMigrationProcedure(
            capabilities,
            database,
            nodeDefs,
            migrationCallback(capabilities),
        );
        const incrementalGraph = makeIncrementalGraph(
            capabilities,
            database,
            nodeDefs
        );
        interfaceInstance._database = database;
        interfaceInstance._incrementalGraph = incrementalGraph;
        interfaceInstance._allEventsBox = allEventsBox;
        interfaceInstance._configBox = configBox;
        interfaceInstance._diarySummaryBox = diarySummaryBox;
        interfaceInstance._ontologyBox = ontologyBox;
    } catch (error) {
        try {
            await database.close();
        } catch (closeError) {
            // Swallow close errors to avoid masking the original failure.
            capabilities.logger.logDebug(
                { closeError },
                `Failed to close database after initialization failure: ${closeError}`,
            );
        }
        throw error;
    }
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {{ resetToHostname?: string }} [options]
 */
async function internalSynchronizeDatabase(interfaceInstance, options) {
    await withExclusiveMode(interfaceInstance._getCapabilities().sleeper, async () => {
        await internalSynchronizeDatabaseNoLock(interfaceInstance, options);
    });
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {{ resetToHostname?: string }} [options]
 * @returns {Promise<void>}
 */
async function internalSynchronizeDatabaseNoLock(interfaceInstance, options) {
    const capabilities = interfaceInstance._getCapabilities();
    const database = interfaceInstance._database;
    const incrementalGraph = interfaceInstance._incrementalGraph;
    const allEventsBox = interfaceInstance._allEventsBox;
    const configBox = interfaceInstance._configBox;
    const diarySummaryBox = interfaceInstance._diarySummaryBox;
    const ontologyBox = interfaceInstance._ontologyBox;
    if (database === null) {
        await synchronizeNoLock(capabilities, options);
        return;
    }

    interfaceInstance._database = null;
    interfaceInstance._incrementalGraph = null;
    interfaceInstance._allEventsBox = null;
    interfaceInstance._configBox = null;
    interfaceInstance._diarySummaryBox = null;
    interfaceInstance._ontologyBox = null;

    try {
        await database.close();
    } catch (error) {
        interfaceInstance._database = database;
        interfaceInstance._incrementalGraph = incrementalGraph;
        interfaceInstance._allEventsBox = allEventsBox;
        interfaceInstance._configBox = configBox;
        interfaceInstance._diarySummaryBox = diarySummaryBox;
        interfaceInstance._ontologyBox = ontologyBox;
        throw error;
    }

    let synchronizeFailure = null;

    try {
        await synchronizeNoLock(capabilities, options);
    } catch (error) {
        synchronizeFailure = error;
    }

    let reopenFailure = null;
    try {
        await internalEnsureInitializedWithMigration(
            interfaceInstance,
            runMigrationUnsafe
        );
    } catch (error) {
        reopenFailure = error;
    }

    if (reopenFailure !== null) {
        if (synchronizeFailure !== null) {
            throw makeSynchronizeDatabaseError(
                synchronizeFailure,
                reopenFailure
            );
        }
        throw reopenFailure;
    }
    if (synchronizeFailure !== null) {
        throw synchronizeFailure;
    }
}

module.exports = {
    internalEnsureInitialized,
    internalEnsureInitializedWithMigration,
    internalIsInitialized,
    internalRequireInitializedGraph,
    internalSynchronizeDatabase,
    internalSynchronizeDatabaseNoLock,
};
