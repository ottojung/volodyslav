/**
 * Invalidation operations for IncrementalGraph.
 */

/** @typedef {import('./class').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

const { stringToNodeName } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withMutex } = require("./lock");
const { serializeNodeKey } = require("./node_key");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @param {IncrementalGraph} incrementalGraph
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
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @param {BatchBuilder | undefined} [externalBatch]
 * @returns {Promise<void>}
 */
async function internalUnsafeInvalidate(
    incrementalGraph,
    nodeName,
    bindings,
    externalBatch = undefined
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

    if (externalBatch !== undefined) {
        return run(externalBatch);
    }
    await incrementalGraph.storage.withBatch(run);
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @param {BatchBuilder | undefined} [externalBatch]
 * @returns {Promise<void>}
 */
async function internalInvalidate(
    incrementalGraph,
    nodeName,
    bindings = [],
    externalBatch = undefined
) {
    return withMutex(incrementalGraph.sleeper, () =>
        internalUnsafeInvalidate(
            incrementalGraph,
            nodeName,
            bindings,
            externalBatch
        )
    );
}

module.exports = {
    internalInvalidate,
    internalPropagateOutdated,
    internalUnsafeInvalidate,
};
