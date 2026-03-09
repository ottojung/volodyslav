/**
 * Graph-facing API methods for the generators interface.
 */

/** @typedef {import('./class').Interface} Interface */

/**
 * @param {Interface} interfaceInstance
 * @returns {Promise<void>}
 */
async function internalUpdate(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    await interfaceInstance._requireInitializedGraph().invalidate("all_events");
}

/**
 * @param {Interface} interfaceInstance
 * @returns {Array<import('../incremental_graph/types').CompiledNode>}
 */
function internalDebugGetSchemas(interfaceInstance) {
    return interfaceInstance._requireInitializedGraph().debugGetSchemas();
}

/**
 * @param {Interface} interfaceInstance
 * @param {string} head
 * @returns {import('../incremental_graph/types').CompiledNode | null}
 */
function internalDebugGetSchemaByHead(interfaceInstance, head) {
    return interfaceInstance._requireInitializedGraph().debugGetSchemaByHead(head);
}

/**
 * @param {Interface} interfaceInstance
 * @returns {Promise<Array<[string, Array<import('../incremental_graph/types').ConstValue>]>>}
 */
async function internalDebugListMaterializedNodes(interfaceInstance) {
    return await interfaceInstance
        ._requireInitializedGraph()
        .debugListMaterializedNodes();
}

/**
 * @param {Interface} interfaceInstance
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
 * @param {Interface} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').ComputedValue | undefined>}
 */
async function internalDebugGetValue(interfaceInstance, head, args = []) {
    return await interfaceInstance._requireInitializedGraph().debugGetValue(head, args);
}

/**
 * @param {Interface} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<import('../incremental_graph/types').ComputedValue>}
 */
async function internalPullGraphNode(interfaceInstance, head, args = []) {
    return await interfaceInstance._requireInitializedGraph().pull(head, args);
}

/**
 * @param {Interface} interfaceInstance
 * @param {string} head
 * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
 * @returns {Promise<void>}
 */
async function internalInvalidateGraphNode(interfaceInstance, head, args = []) {
    return await interfaceInstance._requireInitializedGraph().invalidate(head, args);
}

/**
 * @param {Interface} interfaceInstance
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
 * @param {Interface} interfaceInstance
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
    internalUpdate,
};
