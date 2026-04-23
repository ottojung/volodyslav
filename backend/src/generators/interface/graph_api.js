/**
 * Graph-facing API methods for the generators interface.
 */

/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */

const { withMutex } = require("../incremental_graph/lock");

/**
 * @typedef {object} InterfaceGraphAccess
 * @property {() => GeneratorsCapabilities} _getCapabilities
 * @property {() => Promise<void>} ensureInitialized
 * @property {() => import('../incremental_graph').IncrementalGraph} _requireInitializedGraph
 * @property {import('../individual/all_events/wrapper').AllEventsBox | null} _allEventsBox
 * @property {import('../individual/config/wrapper').ConfigBox | null} _configBox
 * @property {import('../individual/diary_most_important_info_summary/wrapper').DiarySummaryBox | null} _diarySummaryBox
 * @property {import('../individual/ontology/wrapper').OntologyBox | null} _ontologyBox
 */

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {Array<import('../../event').Event>} newEntries
 * @returns {Promise<void>}
 */
async function internalUpdate(interfaceInstance, newEntries) {
    await interfaceInstance.ensureInitialized();
    // Hold MUTEX_KEY for the entire critical section so that synchronizeDatabase()
    // (which also acquires MUTEX_KEY via withExclusiveMode) cannot run between
    // the invalidate and pull calls and set _incrementalGraph to null.
    const capabilities = interfaceInstance._getCapabilities();
    await withMutex(capabilities.sleeper, async () => {
        if (interfaceInstance._allEventsBox === null) {
            throw new Error("Impossible: expected all_events box to be initialized");
        }
        interfaceInstance._allEventsBox.value = newEntries;
        await interfaceInstance._requireInitializedGraph().invalidate("all_events");
        // Immediately pull to persist the new value to the database so it survives restarts.
        // Without this, a restart before the next pull would cause the initial empty state to
        // be computed and stored, resulting in data loss.
        await interfaceInstance._requireInitializedGraph().pull("all_events");
    });
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {import('../../config/structure').Config | null} config
 * @returns {Promise<void>}
 */
async function internalSetConfig(interfaceInstance, config) {
    await interfaceInstance.ensureInitialized();
    // Hold MUTEX_KEY for the entire critical section so that synchronizeDatabase()
    // cannot run between the invalidate and pull calls.
    const capabilities = interfaceInstance._getCapabilities();
    await withMutex(capabilities.sleeper, async () => {
        if (interfaceInstance._configBox === null) {
            throw new Error("Impossible: expected config box to be initialized");
        }
        interfaceInstance._configBox.value = config;
        await interfaceInstance._requireInitializedGraph().invalidate("config");
        // Immediately pull to persist the new value to the database so it survives restarts.
        await interfaceInstance._requireInitializedGraph().pull("config");
    });
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {import('../../generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} value
 * @returns {Promise<void>}
 */
async function internalSetDiarySummary(interfaceInstance, value) {
    await interfaceInstance.ensureInitialized();
    // Hold MUTEX_KEY for the entire critical section so that synchronizeDatabase()
    // cannot run between the invalidate and pull calls.
    const capabilities = interfaceInstance._getCapabilities();
    await withMutex(capabilities.sleeper, async () => {
        if (interfaceInstance._diarySummaryBox === null) {
            throw new Error("Impossible: expected diary summary box to be initialized");
        }
        interfaceInstance._diarySummaryBox.value = value;
        await interfaceInstance._requireInitializedGraph().invalidate("diary_most_important_info_summary");
        // Immediately pull to persist the new value to the database so it survives restarts.
        await interfaceInstance._requireInitializedGraph().pull("diary_most_important_info_summary");
    });
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {import('../../ontology/structure').Ontology | null} ontology
 * @returns {Promise<void>}
 */
async function internalSetOntology(interfaceInstance, ontology) {
    await interfaceInstance.ensureInitialized();
    // Hold MUTEX_KEY for the entire critical section so that synchronizeDatabase()
    // cannot run between the invalidate and pull calls.
    const capabilities = interfaceInstance._getCapabilities();
    await withMutex(capabilities.sleeper, async () => {
        if (interfaceInstance._ontologyBox === null) {
            throw new Error("Impossible: expected ontology box to be initialized");
        }
        interfaceInstance._ontologyBox.value = ontology;
        await interfaceInstance._requireInitializedGraph().invalidate("ontology");
        await interfaceInstance._requireInitializedGraph().pull("ontology");
    });
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @returns {Array<import('../incremental_graph/types').CompiledNode>}
 */
function internalGetSchemas(interfaceInstance) {
    return interfaceInstance._requireInitializedGraph().getSchemas();
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @returns {import('../incremental_graph/types').CompiledNode | null}
 */
function internalGetSchemaByHead(interfaceInstance, head) {
    return interfaceInstance._requireInitializedGraph().getSchemaByHead(head);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @returns {Promise<Array<[string, Array<import('../incremental_graph/types').ConstValue>]>>}
 */
async function internalListMaterializedNodes(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance
        ._requireInitializedGraph()
        .listMaterializedNodes();
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').FreshnessStatus>}
 */
async function internalGetFreshness(interfaceInstance, head, args = []) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance
        ._requireInitializedGraph()
        .getFreshness(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').ComputedValue | undefined>}
 */
async function internalGetValue(interfaceInstance, head, args = []) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance._requireInitializedGraph().getValue(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').ComputedValue>}
 */
async function internalPullGraphNode(interfaceInstance, head, args = []) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance._requireInitializedGraph().pull(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<void>}
 */
async function internalInvalidateGraphNode(interfaceInstance, head, args = []) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance._requireInitializedGraph().invalidate(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../../datetime').DateTime>}
 */
async function internalGetCreationTime(interfaceInstance, head, args = []) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance
        ._requireInitializedGraph()
        .getCreationTime(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../../datetime').DateTime>}
 */
async function internalGetModificationTime(interfaceInstance, head, args = []) {
    await interfaceInstance.ensureInitialized();
    return await interfaceInstance
        ._requireInitializedGraph()
        .getModificationTime(head, args);
}

module.exports = {
    internalGetFreshness,
    internalGetSchemaByHead,
    internalGetSchemas,
    internalGetValue,
    internalListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
    internalInvalidateGraphNode,
    internalPullGraphNode,
    internalSetConfig,
    internalSetDiarySummary,
    internalSetOntology,
    internalUpdate,
};
