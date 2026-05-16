/**
 * Invalidation operations for IncrementalGraph.
 */

/** @typedef {import('./semantic_graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/**
 * @typedef {object} IncrementalGraphInvalidateAccess
 * @property {Map<import('./types').NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./semantic_graph_storage').GraphStorage} storage
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 */

const { stringToNodeName } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withObserveMode } = require("./lock");
const { serializeNodeKey } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @param {IncrementalGraphInvalidateAccess} incrementalGraph
 * @param {NodeKeyString} changedKey
 * @param {BatchBuilder} batch
 * @param {Set<NodeKeyString>} [nodesBecomingOutdated]
 * @returns {Promise<void>}
 */
async function internalPropagateOutdated(
    incrementalGraph,
    changedKey,
    batch,
    nodesBecomingOutdated = new Set()
) {
    const dynamicDependents = await incrementalGraph.storage.listDependents(
        changedKey,
        batch
    );
    for (const output of dynamicDependents) {
        if (nodesBecomingOutdated.has(output)) {
            continue;
        }

        const currentFreshness = await batch.freshness.get(output);
        if (currentFreshness === "up-to-date") {
            batch.freshness.put(output, "potentially-outdated");
            nodesBecomingOutdated.add(output);
            await internalPropagateOutdated(
                incrementalGraph,
                output,
                batch,
                nodesBecomingOutdated
            );
            continue;
        }
        if (
            currentFreshness === undefined ||
            currentFreshness === "potentially-outdated"
        ) {
            continue;
        }

        /** @type {never} */
        const freshness = currentFreshness;
        throw new Error(
            `Unexpected freshness value ${freshness} for node ${output}`
        );
    }
}

/**
 * @param {IncrementalGraphInvalidateAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @returns {Promise<void>}
 */
async function internalUnsafeInvalidate(
    incrementalGraph,
    nodeName,
    bindings
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
    const nodeDefinition = incrementalGraph.getOrCreateConcreteNode(
        concreteKey,
        compiledNode,
        bindings
    );

    /**
     * @param {BatchBuilder} batch
     * @returns {Promise<void>}
     */
    const run = async (batch) => {
        batch.freshness.put(nodeDefinition.output, "potentially-outdated");

        const inputCounters = [];
        for (const inputKey of nodeDefinition.inputs) {
            const counter = await batch.counters.get(inputKey);
            inputCounters.push(counter !== undefined ? counter : 0);
        }

        await incrementalGraph.storage.ensureMaterialized(
            nodeDefinition.output,
            nodeDefinition.inputs,
            inputCounters,
            batch
        );
        await internalPropagateOutdated(
            incrementalGraph,
            nodeDefinition.output,
            batch
        );
    };

    await incrementalGraph.storage.withBatch(run);
}

/**
 * @param {IncrementalGraphInvalidateAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<void>}
 */
async function internalInvalidate(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return withObserveMode(incrementalGraph.sleeper, () =>
        internalUnsafeInvalidate(incrementalGraph, nodeName, bindings)
    );
}

module.exports = {
    internalInvalidate,
    internalPropagateOutdated,
    internalUnsafeInvalidate,
};
