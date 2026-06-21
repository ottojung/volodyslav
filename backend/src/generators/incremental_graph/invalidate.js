/**
 * Invalidation operations for IncrementalGraph.
 *
 * Transaction context is passed explicitly through the call stack.
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * @typedef {object} IncrementalGraphInvalidateAccess
 * @property {Map<import('./types').NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_state').GraphStorage} storage
 */

const { stringToNodeName, nodeIdentifierToString, serializeNodeKey } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { daytimeActivity } = require("./lock");
const { checkArity, ensureNodeNameIsHead } = require("./shared");
const { lookupNodeIdentifier } = require("./graph_state");

/**
 * @param {IncrementalGraphInvalidateAccess} incrementalGraph
 * @param {import('./database/types').NodeIdentifier} changedIdentifier
 * @param {BatchBuilder} batch
 * @param {Set<string>} [nodesBecomingOutdated]
 * @returns {Promise<void>}
 */
async function internalPropagateOutdated(
    incrementalGraph,
    changedIdentifier,
    batch,
    nodesBecomingOutdated = new Set()
) {
    const dynamicDependents = await incrementalGraph.storage.getValid(
        changedIdentifier,
        batch
    );
    for (const output of dynamicDependents) {
        const outputIdentifierString = nodeIdentifierToString(output);
        if (nodesBecomingOutdated.has(outputIdentifierString)) {
            continue;
        }

        nodesBecomingOutdated.add(outputIdentifierString);
        const currentFreshness = await batch.freshness.get(output);
        if (currentFreshness === "up-to-date") {
            batch.freshness.put(output, "potentially-outdated");
        } else if (
            currentFreshness !== undefined &&
            currentFreshness !== "potentially-outdated"
        ) {
            /** @type {never} */
            const freshness = currentFreshness;
            throw new Error(
                `Unexpected freshness value ${freshness} for node ${outputIdentifierString}`
            );
        }
        await internalPropagateOutdated(
            incrementalGraph,
            output,
            batch,
            nodesBecomingOutdated
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

    await incrementalGraph.storage.withTransaction(async (tx) => {
        const outputIdentifier = lookupNodeIdentifier(tx, concreteKey);
        if (outputIdentifier === undefined) {
            return { value: undefined };
        }

        if (await tx.batch.values.get(outputIdentifier) === undefined) {
            return { value: undefined };
        }

        tx.batch.freshness.put(outputIdentifier, "potentially-outdated");
        await internalPropagateOutdated(incrementalGraph, outputIdentifier, tx.batch);

        return { value: undefined };
    });
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
    return daytimeActivity(incrementalGraph.sleeper, () =>
        internalUnsafeInvalidate(incrementalGraph, nodeName, bindings)
    );
}

module.exports = {
    internalInvalidate,
    internalPropagateOutdated,
};
