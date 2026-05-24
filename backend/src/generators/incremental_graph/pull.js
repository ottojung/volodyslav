/**
 * Pull operations for IncrementalGraph.
 */

/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./identifier_resolver').IdentifierResolver} IdentifierResolver */
/**
 * @typedef {object} IncrementalGraphPullAccess
 * @property {Map<NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_storage').GraphStorage} storage
 * @property {(procedure: (batch: BatchBuilder, identifierResolver: IdentifierResolver) => Promise<RecomputeResult>) => Promise<RecomputeResult>} withIdentifierBatch
 * @property {(nodeDefinition: import('./types').ConcreteNode, identifierResolver: IdentifierResolver) => import('./types').ResolvedConcreteNode} resolveConcreteNode
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 * @property {(nodeDefinition: import('./types').ResolvedConcreteNode, batch: BatchBuilder, identifierResolver: IdentifierResolver) => Promise<RecomputeResult>} maybeRecalculate
 * @property {(nodeKeyStr: NodeKeyString, identifierResolver: IdentifierResolver, outerBatch: BatchBuilder) => Promise<RecomputeResult>} _pullDuringPull
 * @property {(nodeIdentifier: NodeIdentifier) => import('./types').NodeKeyString | undefined} lookupNodeKey
 * @property {() => ({ identifierResolver: IdentifierResolver, batch: BatchBuilder } | null)} [getActivePullContext]
 */

const { stringToNodeName } = require("./database");
const { stringToNodeKeyString } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withPullMode } = require("./lock");
const { deserializeNodeKey, serializeNodeKey } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * Pull implementation that assumes the caller has already acquired the global
 * pull-mode lock.
 *
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @returns {Promise<ComputedValue>}
 */
async function internalUnsafePull(
    incrementalGraph,
    nodeName,
    bindings
) {
    ensureNodeNameIsHead(nodeName);
    const nodeNameValue = stringToNodeName(nodeName);
    const { value } = await internalPullWithStatus(
        incrementalGraph,
        nodeNameValue,
        bindings
    );
    return value;
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<ComputedValue>}
 */
async function internalPull(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return withPullMode(incrementalGraph.sleeper, () =>
        internalUnsafePull(incrementalGraph, nodeName, bindings)
    );
}

/**
 * Pull-with-status implementation that acquires the global pull-mode lock
 * and then delegates to internalPullWithStatus.
 *
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<RecomputeResult>}
 */
async function internalSafePullWithStatus(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return withPullMode(incrementalGraph.sleeper, () =>
        internalPullWithStatus(incrementalGraph, nodeName, bindings)
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullWithStatus(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    const nodeKey = { head: nodeName, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    return await internalPullByNodeKeyWithStatusDuringPull(
        incrementalGraph,
        concreteKey
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeKeyString} nodeKeyStr
 * @param {IdentifierResolver | null} [identifierResolver=null]
 * @param {BatchBuilder | null} [outerBatch=null]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeKeyWithStatusDuringPull(
    incrementalGraph,
    nodeKeyStr,
    identifierResolver = null,
    outerBatch = null
) {
    return runPullForSemanticNodeKey(
        incrementalGraph,
        nodeKeyStr,
        identifierResolver,
        outerBatch
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeIdentifier} nodeKeyStr
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeIdentifierWithStatus(
    incrementalGraph,
    nodeKeyStr
) {
    return withPullMode(incrementalGraph.sleeper, () =>
        internalPullByNodeIdentifierWithStatusDuringPull(
            incrementalGraph,
            nodeKeyStr
        )
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeIdentifierWithStatusDuringPull(
    incrementalGraph,
    nodeIdentifier
) {
    // If we are inside an active pull context (e.g. called from within a computor
    // that was triggered by an outer pull), reuse the outer resolver and batch so
    // we do not re-acquire withComputedStateMutex.
    const activePullContext =
        typeof incrementalGraph.getActivePullContext === "function"
            ? incrementalGraph.getActivePullContext()
            : null;

    if (activePullContext !== null) {
        const nodeKey = activePullContext.identifierResolver.requireNodeKey(nodeIdentifier);
        return runPullForSemanticNodeKey(
            incrementalGraph,
            nodeKey,
            activePullContext.identifierResolver,
            activePullContext.batch
        );
    }

    // Top-level call: look up the key from the active volatile lookup (lock-free read).
    // The identifier must already be persisted; if not, the pull will fail anyway.
    const nodeKey = incrementalGraph.lookupNodeKey(nodeIdentifier);
    if (nodeKey === undefined) {
        throw new Error(
            `Missing semantic node key for identifier: cannot pull by unknown identifier`
        );
    }
    return runPullForSemanticNodeKey(
        incrementalGraph,
        nodeKey,
        null,
        null
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeKeyString} semanticNodeKey
 * @param {IdentifierResolver | null} identifierResolver
 * @param {BatchBuilder | null} [outerBatch=null]
 * @returns {Promise<RecomputeResult>}
 */
async function runPullForSemanticNodeKey(
    incrementalGraph,
    semanticNodeKey,
    identifierResolver,
    outerBatch = null
) {
    let effectiveIdentifierResolver = identifierResolver;
    let effectiveOuterBatch = outerBatch;
    if (effectiveOuterBatch === null) {
        const activePullContext =
            typeof incrementalGraph.getActivePullContext === "function"
                ? incrementalGraph.getActivePullContext()
                : null;
        if (activePullContext !== null) {
            effectiveIdentifierResolver = activePullContext.identifierResolver;
            effectiveOuterBatch = activePullContext.batch;
        }
    }

    const nodeKey = deserializeNodeKey(stringToNodeKeyString(String(semanticNodeKey)));
    const nodeName = nodeKey.head;
    const bindings = nodeKey.args;
    const compiledNode = incrementalGraph.headIndex.get(nodeName);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeName);
    }

    checkArity(compiledNode, bindings);

    const concreteNode = incrementalGraph.getOrCreateConcreteNode(
        semanticNodeKey,
        compiledNode,
        bindings
    );

    /**
     * Core computation logic. Runs with a specific resolver and batch.
     * Used for both nested pulls (passing the shared outer resolver/batch) and
     * for top-level pulls (passing the resolver and batch created inside
     * withIdentifierBatch).
     * @param {BatchBuilder} batch
     * @param {IdentifierResolver} resolver
     * @returns {Promise<RecomputeResult>}
     */
    const runWithContext = async (batch, resolver) => {
        const outputIdentifier = resolver.getOrAllocateNodeIdentifier(
            concreteNode.output
        );
        const nodeFreshness = await batch.freshness.get(
            outputIdentifier
        );

        if (nodeFreshness === "up-to-date") {
            const result = await batch.values.get(outputIdentifier);
            if (result === undefined) {
                throw new Error(
                    `Impossible: up-to-date node has no stored value: ${String(semanticNodeKey)}`
                );
            }
            return { value: result, status: "cached" };
        }

        const nodeDefinition = incrementalGraph.resolveConcreteNode(
            concreteNode,
            resolver
        );
        return await incrementalGraph.maybeRecalculate(
            nodeDefinition,
            batch,
            resolver
        );
    };

    if (effectiveOuterBatch !== null) {
        // Nested call: the outer pull already holds withComputedStateMutex and has
        // created the shared batch. Running withIdentifierBatch here would deadlock
        // on the same computed-state mutex.
        // effectiveOuterBatch is only set when an ancestor pull operation already
        // entered withComputedStateMutex for this computed state.
        // Instead, execute directly with the shared batch — the outer pull's commit
        // covers all identifier allocations and node-data writes for the entire tree.
        if (effectiveIdentifierResolver === null) {
            throw new Error(
                `Invariant violation: effectiveOuterBatch is set but effectiveIdentifierResolver is null`
            );
        }
        return runWithContext(effectiveOuterBatch, effectiveIdentifierResolver);
    }

    // Top-level pull: acquire the computed-state lock and create the resolver
    // inside the critical section so it always sees the up-to-date active lookup.
    return incrementalGraph.withIdentifierBatch((batch, freshResolver) =>
        runWithContext(batch, freshResolver)
    );
}

module.exports = {
    internalPull,
    internalPullByNodeKeyWithStatusDuringPull,
    internalPullByNodeIdentifierWithStatusDuringPull,
    internalPullByNodeIdentifierWithStatus,
    internalSafePullWithStatus,
    internalPullWithStatus,
    internalUnsafePull,
};
