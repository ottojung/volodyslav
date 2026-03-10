/**
 * Graph-facing API methods for the generators interface.
 */

/**
 * @typedef {object} InterfaceGraphAccess
 * @property {() => Promise<void>} ensureInitialized
 * @property {() => import('../incremental_graph').IncrementalGraph} _requireInitializedGraph
 */

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @returns {Promise<void>}
 */
async function internalUpdate(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    await interfaceInstance._requireInitializedGraph().invalidate("all_events");
    await interfaceInstance._requireInitializedGraph().invalidate("config");
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

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<string>}
 */
async function internalGetCreator(interfaceInstance, head, args = []) {
    return await interfaceInstance
        ._requireInitializedGraph()
        .getCreator(head, args);
}

module.exports = {
    internalDebugGetFreshness,
    internalDebugGetSchemaByHead,
    internalDebugGetSchemas,
    internalDebugGetValue,
    internalDebugListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
    internalGetCreator,
    internalInvalidateGraphNode,
    internalPullGraphNode,
    internalUpdate,
};
