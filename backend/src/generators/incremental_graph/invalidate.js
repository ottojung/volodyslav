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
 * @property {<T>(procedure: (tx: Transaction) => Promise<T>) => Promise<T>} withTransaction
 * @property {(nodeDefinition: import('./types').ConcreteNode, tx: Transaction) => import('./types').ResolvedConcreteNode} resolveConcreteNode
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 */

const { stringToNodeName } = require("./database");
const { nodeIdentifierToString } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withObserveMode } = require("./lock");
const { serializeNodeKey } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

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
    const dynamicDependents = await incrementalGraph.storage.listDependents(
        changedIdentifier,
        batch
    );
    for (const output of dynamicDependents) {
        const outputIdentifierString = nodeIdentifierToString(output);
        if (nodesBecomingOutdated.has(outputIdentifierString)) {
            continue;
        }

        const currentFreshness = await batch.freshness.get(output);
        if (currentFreshness === "up-to-date") {
            batch.freshness.put(output, "potentially-outdated");
            nodesBecomingOutdated.add(outputIdentifierString);
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
            `Unexpected freshness value ${freshness} for node ${outputIdentifierString}`
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
    const concreteNode = incrementalGraph.getOrCreateConcreteNode(
        concreteKey,
        compiledNode,
        bindings
    );

    /**
     * @param {Transaction} tx
     * @returns {Promise<void>}
     */
    const run = async (tx) => {
        const nodeDefinition = incrementalGraph.resolveConcreteNode(
            concreteNode,
            tx
        );
        tx.batch.freshness.put(nodeDefinition.outputIdentifier, "potentially-outdated");

        const inputCounters = [];
        for (const inputIdentifier of nodeDefinition.inputIdentifiers) {
            const counter = await tx.batch.counters.get(inputIdentifier);
            inputCounters.push(counter !== undefined ? counter : 0);
        }

        await incrementalGraph.storage.ensureMaterialized(
            nodeDefinition.outputIdentifier,
            nodeDefinition.inputIdentifiers,
            inputCounters,
            tx.batch
        );
        await internalPropagateOutdated(
            incrementalGraph,
            nodeDefinition.outputIdentifier,
            tx.batch
        );
    };

    await incrementalGraph.withTransaction(run);
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
