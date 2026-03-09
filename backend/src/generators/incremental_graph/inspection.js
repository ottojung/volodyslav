/**
 * Inspection and timestamp helpers for IncrementalGraph.
 */

/** @typedef {import('./class').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('../../datetime').DateTime} DateTime */

const {
    nodeNameToString,
    stringToNodeName,
    versionToString,
} = require("./database");
const { makeInvalidNodeError, makeMissingTimestampError } = require("./errors");
const { deserializeNodeKey, serializeNodeKey } = require("./node_key");
const { fromISOString } = require("../../datetime");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} head
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
 */
async function internalDebugGetFreshness(
    incrementalGraph,
    head,
    bindings = []
) {
    const nodeName = stringToNodeName(head);
    const compiledNode = incrementalGraph.headIndex.get(nodeName);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeName);
    }

    checkArity(compiledNode, bindings);

    const nodeKey = { head: nodeName, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    const freshness = await incrementalGraph.storage.freshness.get(concreteKey);
    if (freshness === undefined) {
        return "missing";
    }
    return freshness;
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} head
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<import('./types').ComputedValue | undefined>}
 */
async function internalDebugGetValue(incrementalGraph, head, bindings = []) {
    const nodeName = stringToNodeName(head);
    const compiledNode = incrementalGraph.headIndex.get(nodeName);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeName);
    }

    checkArity(compiledNode, bindings);

    const nodeKey = { head: nodeName, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    return await incrementalGraph.storage.values.get(concreteKey);
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @returns {Array<CompiledNode>}
 */
function internalDebugGetSchemas(incrementalGraph) {
    return Array.from(incrementalGraph.headIndex.values());
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} head
 * @returns {CompiledNode | null}
 */
function internalDebugGetSchemaByHead(incrementalGraph, head) {
    const nodeName = stringToNodeName(head);
    return incrementalGraph.headIndex.get(nodeName) ?? null;
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @returns {Promise<Array<[string, Array<ConstValue>]>>}
 */
async function internalDebugListMaterializedNodes(incrementalGraph) {
    const materializedNodes = await incrementalGraph.storage.listMaterializedNodes();
    return materializedNodes.map((nodeKey) => {
        const parsed = deserializeNodeKey(nodeKey);
        return [nodeNameToString(parsed.head), parsed.args];
    });
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @returns {string}
 */
function internalDebugGetDbVersion(incrementalGraph) {
    return versionToString(incrementalGraph.dbVersion);
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<DateTime>}
 */
async function internalGetCreationTime(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    ensureNodeNameIsHead(nodeName);
    const nodeNameTyped = stringToNodeName(nodeName);
    const compiledNode = incrementalGraph.headIndex.get(nodeNameTyped);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeNameTyped);
    }

    checkArity(compiledNode, bindings);

    const nodeKey = { head: nodeNameTyped, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    const record = await incrementalGraph.storage.timestamps.get(concreteKey);
    if (record === undefined) {
        throw makeMissingTimestampError(concreteKey);
    }
    return fromISOString(record.createdAt);
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<DateTime>}
 */
async function internalGetModificationTime(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    ensureNodeNameIsHead(nodeName);
    const nodeNameTyped = stringToNodeName(nodeName);
    const compiledNode = incrementalGraph.headIndex.get(nodeNameTyped);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeNameTyped);
    }

    checkArity(compiledNode, bindings);

    const nodeKey = { head: nodeNameTyped, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    const record = await incrementalGraph.storage.timestamps.get(concreteKey);
    if (record === undefined) {
        throw makeMissingTimestampError(concreteKey);
    }
    return fromISOString(record.modifiedAt);
}

module.exports = {
    internalDebugGetDbVersion,
    internalDebugGetFreshness,
    internalDebugGetSchemaByHead,
    internalDebugGetSchemas,
    internalDebugGetValue,
    internalDebugListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
};
