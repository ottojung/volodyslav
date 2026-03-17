/**
 * Graph-facing API methods for the generators interface.
 */

/**
 * @typedef {object} InterfaceGraphAccess
 * @property {() => Promise<void>} ensureInitialized
 * @property {() => import('../incremental_graph').IncrementalGraph} _requireInitializedGraph
 * @property {import('../individual/all_events/wrapper').AllEventsBox | null} _allEventsBox
 * @property {import('../individual/config/wrapper').ConfigBox | null} _configBox
 */

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {Array<import('../../event').Event>} newEntries
 * @returns {Promise<void>}
 */
async function internalUpdate(interfaceInstance, newEntries) {
    await interfaceInstance.ensureInitialized();
    if (interfaceInstance._allEventsBox === null) {
        throw new Error("Impossible: expected all_events box to be initialized");
    }
    interfaceInstance._allEventsBox.value = newEntries;
    await interfaceInstance._requireInitializedGraph().invalidate("all_events");
    // Immediately pull to persist the new value to the database so it survives restarts.
    // Without this, a restart before the next pull would cause the initial empty state to
    // be computed and stored, resulting in data loss.
    await interfaceInstance._requireInitializedGraph().pull("all_events");
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {import('../../config/structure').Config | null} config
 * @returns {Promise<void>}
 */
async function internalSetConfig(interfaceInstance, config) {
    await interfaceInstance.ensureInitialized();
    if (interfaceInstance._configBox === null) {
        throw new Error("Impossible: expected config box to be initialized");
    }
    interfaceInstance._configBox.value = config;
    await interfaceInstance._requireInitializedGraph().invalidate("config");
    // Immediately pull to persist the new value to the database so it survives restarts.
    await interfaceInstance._requireInitializedGraph().pull("config");
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @returns {Array<import('../incremental_graph/types').CompiledNode>}
 */
function internalDebugGetSchemas(interfaceInstance) {
    return interfaceInstance._requireInitializedGraph().debugGetSchemas();
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @returns {import('../incremental_graph/types').CompiledNode | null}
 */
function internalDebugGetSchemaByHead(interfaceInstance, head) {
    return interfaceInstance._requireInitializedGraph().debugGetSchemaByHead(head);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @returns {Promise<Array<[string, Array<import('../incremental_graph/types').ConstValue>]>>}
 */
async function internalDebugListMaterializedNodes(interfaceInstance) {
    return await interfaceInstance
        ._requireInitializedGraph()
        .debugListMaterializedNodes();
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').FreshnessStatus>}
 */
async function internalDebugGetFreshness(interfaceInstance, head, args = []) {
    return await interfaceInstance
        ._requireInitializedGraph()
        .debugGetFreshness(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').ComputedValue | undefined>}
 */
async function internalDebugGetValue(interfaceInstance, head, args = []) {
    return await interfaceInstance._requireInitializedGraph().debugGetValue(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').ComputedValue>}
 */
async function internalPullGraphNode(interfaceInstance, head, args = []) {
    return await interfaceInstance._requireInitializedGraph().pull(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<void>}
 */
async function internalInvalidateGraphNode(interfaceInstance, head, args = []) {
    return await interfaceInstance._requireInitializedGraph().invalidate(head, args);
}

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../../datetime').DateTime>}
 */
async function internalGetCreationTime(interfaceInstance, head, args = []) {
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
    return await interfaceInstance
        ._requireInitializedGraph()
        .getModificationTime(head, args);
}

module.exports = {
    internalDebugGetFreshness,
    internalDebugGetSchemaByHead,
    internalDebugGetSchemas,
    internalDebugGetValue,
    internalDebugListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
    internalInvalidateGraphNode,
    internalPullGraphNode,
    internalSetConfig,
    internalUpdate,
};
