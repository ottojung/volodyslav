/**
 * Graph-facing API methods for the generators interface.
 */

const { serialize } = require("../../event");
const {
    stringToNodeName,
    internalPropagateOutdated,
    serializeNodeKey,
} = require("../incremental_graph");

/**
 * @typedef {object} InterfaceGraphAccess
 * @property {() => Promise<void>} ensureInitialized
 * @property {() => import('../incremental_graph').IncrementalGraph} _requireInitializedGraph
 * @property {() => import('./types').GeneratorsCapabilities} _getCapabilities
 */

/**
 * @param {InterfaceGraphAccess} interfaceInstance
 * @param {Array<import('../../event').Event>} newEntries
 * @returns {Promise<void>}
 */
async function internalUpdate(interfaceInstance, newEntries) {
    await interfaceInstance.ensureInitialized();
    const graph = interfaceInstance._requireInitializedGraph();
    const capabilities = interfaceInstance._getCapabilities();
    /** @type {import('../incremental_graph/database/types').AllEventsEntry} */
    const nextValue = {
        type: "all_events",
        events: newEntries.map((entry) => serialize(capabilities, entry)),
    };
    const nodeKey = serializeNodeKey({
        head: stringToNodeName("all_events"),
        args: [],
    });

    await graph.storage.withBatch(async (batch) => {
        const oldValue = await batch.values.get(nodeKey);
        const isUnchanged =
            oldValue !== undefined &&
            oldValue.type === "all_events" &&
            JSON.stringify(oldValue.events) === JSON.stringify(nextValue.events);

        if (isUnchanged) {
            await graph.storage.ensureMaterialized(nodeKey, [], [], batch);
            batch.freshness.put(nodeKey, "up-to-date");
            return;
        }

        const oldCounter = await batch.counters.get(nodeKey);
        const nowIso = graph.datetime.now().toISOString();
        const createdAt = oldCounter === undefined
            ? nowIso
            : (await batch.timestamps.get(nodeKey))?.createdAt || nowIso;

        batch.values.put(nodeKey, nextValue);
        batch.counters.put(nodeKey, oldCounter === undefined ? 1 : oldCounter + 1);
        batch.timestamps.put(nodeKey, { createdAt, modifiedAt: nowIso });
        await graph.storage.ensureMaterialized(nodeKey, [], [], batch);
        batch.freshness.put(nodeKey, "up-to-date");
        await internalPropagateOutdated(graph, nodeKey, batch);
    });
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
    internalUpdate,
};
