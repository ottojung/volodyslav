/**
 * Inspection and timestamp helpers for IncrementalGraph.
 */

/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('../../datetime').DateTime} DateTime */
/**
 * @typedef {object} IncrementalGraphInspectionAccess
 * @property {Map<import('./types').NodeName, CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_state').GraphStorage} storage
 * @property {import('./database/root_database').RootDatabase} rootDatabase
 * @property {import('./types').Version} dbVersion
 */

const {
    nodeNameToString,
    nodeIdentifierToString,
    stringToNodeName,
    versionToString,
} = require("./database");
const { stringToNodeKeyString } = require("./database");
const { makeInvalidNodeError, makeMissingTimestampError } = require("./errors");
const { deserializeNodeKey, serializeNodeKey } = require("./database");
const { fromISOString } = require("../../datetime");
const { daytimeActivity } = require("./lock");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @param {string} head
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
 */
async function internalGetFreshness(
    incrementalGraph,
    head,
    bindings = []
) {
    return daytimeActivity(incrementalGraph.sleeper, async () => {
        const nodeName = stringToNodeName(head);
        const compiledNode = incrementalGraph.headIndex.get(nodeName);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeName);
        }

        checkArity(compiledNode, bindings);

        const nodeKey = { head: nodeName, args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);
        const nodeIdentifier = incrementalGraph.rootDatabase.nodeKeyToId(concreteKey);
        if (nodeIdentifier === undefined) {
            return "missing";
        }
        const freshness = await incrementalGraph.storage.freshness.get(nodeIdentifier);
        if (freshness === undefined) {
            return "missing";
        }
        return freshness;
    });
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @param {string} head
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<import('./types').ComputedValue | undefined>}
 */
async function internalGetValue(incrementalGraph, head, bindings = []) {
    return daytimeActivity(incrementalGraph.sleeper, async () => {
        const nodeName = stringToNodeName(head);
        const compiledNode = incrementalGraph.headIndex.get(nodeName);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeName);
        }

        checkArity(compiledNode, bindings);

        const nodeKey = { head: nodeName, args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);
        const nodeIdentifier = incrementalGraph.rootDatabase.nodeKeyToId(concreteKey);
        if (nodeIdentifier === undefined) {
            return undefined;
        }
        return await incrementalGraph.storage.values.get(nodeIdentifier);
    });
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @returns {Array<CompiledNode>}
 */
function internalGetSchemas(incrementalGraph) {
    return Array.from(incrementalGraph.headIndex.values());
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @param {string} head
 * @returns {CompiledNode | null}
 */
function internalGetSchemaByHead(incrementalGraph, head) {
    const nodeName = stringToNodeName(head);
    return incrementalGraph.headIndex.get(nodeName) ?? null;
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @returns {Promise<Array<[string, Array<ConstValue>]>>}
 */
async function internalListMaterializedNodes(incrementalGraph) {
    return daytimeActivity(incrementalGraph.sleeper, async () =>
        incrementalGraph.storage.withCommitSnapshot(async () => {
            const materializedNodes = await incrementalGraph.storage.listMaterializedNodes();
            return materializedNodes.map((nodeIdentifier) => {
                const nodeKey = incrementalGraph.rootDatabase.nodeIdToKey(nodeIdentifier);
                if (nodeKey === undefined) {
                    throw new Error(
                        `Missing semantic node key for materialized identifier ${nodeIdentifierToString(nodeIdentifier)}: cannot list nodes`
                    );
                }
                const parsed = deserializeNodeKey(stringToNodeKeyString(String(nodeKey)));
                return [nodeNameToString(parsed.head), parsed.args];
            });
        })
    );
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @returns {string}
 */
function internalGetDbVersion(incrementalGraph) {
    return versionToString(incrementalGraph.dbVersion);
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<DateTime>}
 */
async function internalGetCreationTime(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return daytimeActivity(incrementalGraph.sleeper, async () => {
        ensureNodeNameIsHead(nodeName);
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = incrementalGraph.headIndex.get(nodeNameTyped);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeNameTyped);
        }

        checkArity(compiledNode, bindings);

        const nodeKey = { head: nodeNameTyped, args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);
        const nodeIdentifier = incrementalGraph.rootDatabase.nodeKeyToId(concreteKey);
        if (nodeIdentifier === undefined) {
            throw makeMissingTimestampError(concreteKey);
        }
        const record = await incrementalGraph.storage.timestamps.get(nodeIdentifier);
        if (record === undefined) {
            throw makeMissingTimestampError(concreteKey);
        }
        return fromISOString(record.createdAt);
    });
}

/**
 * @param {IncrementalGraphInspectionAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<DateTime>}
 */
async function internalGetModificationTime(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return daytimeActivity(incrementalGraph.sleeper, async () => {
        ensureNodeNameIsHead(nodeName);
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = incrementalGraph.headIndex.get(nodeNameTyped);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeNameTyped);
        }

        checkArity(compiledNode, bindings);

        const nodeKey = { head: nodeNameTyped, args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);
        const nodeIdentifier = incrementalGraph.rootDatabase.nodeKeyToId(concreteKey);
        if (nodeIdentifier === undefined) {
            throw makeMissingTimestampError(concreteKey);
        }
        const record = await incrementalGraph.storage.timestamps.get(nodeIdentifier);
        if (record === undefined) {
            throw makeMissingTimestampError(concreteKey);
        }
        return fromISOString(record.modifiedAt);
    });
}

module.exports = {
    internalGetDbVersion,
    internalGetFreshness,
    internalGetSchemaByHead,
    internalGetSchemas,
    internalGetValue,
    internalListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
};
