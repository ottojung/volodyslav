/**
 * Recalculation helpers for IncrementalGraph validity tracking.
 *
 * Transaction context is passed explicitly - no async_hooks or push/pop context.
 *
 * Async-boundary safety:
 * All awaits in this module are protected by the dome nighttime activity lock
 * held by the calling pullNode scope. The Transaction object (tx) and its batch
 * are local parameters — no captured reference to _computed.schemaStorage or
 * _computed.identifierLookup survives across await outside the lock.
 * incrementalGraph (the IncrementalGraphClass instance) is a stable reference
 * that is never replaced; storage getters on it resolve against the current
 * replica at each property access.
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ResolvedConcreteNode} ResolvedConcreteNode */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').ComputedValue} ComputedValue */

/**
 * @typedef {object} IncrementalGraphRecomputeAccess
 * @property {import('./graph_state').GraphStorage} storage
 * @property {import('../../datetime').Datetime} datetime
 * @property {import('../../sleeper').SleepCapability} sleeper
 */

const { makeInvalidComputorReturnValueError, makeInvalidUnchangedError } = require("./errors");
const { isUnchanged } = require("./unchanged");
const {
    nodeIdentifierToString,
    ReplicaStateInvariantError,
} = require("./database");
const { lookupNodeIdentifier } = require("./graph_state");
const { normalizeInputEdges } = require("./database");
const { invalidateDependentsFrom, revokeIncomingValidity } = require("./strong_invalidation");

/**
 * Add N to valid[D] for each dependency D in inputEdges.
 * Records add mutations that are resolved against the latest committed
 * state at commit time under the darkroom lock to prevent lost updates.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} nId
 * @param {NodeIdentifier[]} inputEdges
 * @returns {void}
 */
function addValidityFlags(batch, nId, inputEdges) {
    for (const depId of inputEdges) {
        batch.valid.add(depId, nId);
    }
}

/**
 * Handle Unchanged computor result: add validity flags and preserve valid[N].
 * @param {IncrementalGraphRecomputeAccess} _incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeIdentifier[]} inputEdges
 * @param {BatchBuilder} batch
 * @returns {Promise<void>}
 */
async function handleUnchanged(_incrementalGraph, nodeIdentifier, inputEdges, batch) {
    addValidityFlags(batch, nodeIdentifier, inputEdges);
    batch.freshness.put(nodeIdentifier, "up-to-date");
}

/**
 * Handle changed value computor result: clear old validity, write new value, record new flags.
 *
 * Validity removals and clears are recorded as mutations and resolved
 * against the latest committed state at commit time to prevent lost
 * updates when concurrent transactions modify overlapping validity sets.
 *
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeIdentifier[]} inputEdges
 * @param {ComputedValue} newValue
 * @param {boolean} alreadyMaterialized
 * @param {BatchBuilder} batch
 * @returns {Promise<void>}
 */
async function handleChanged(incrementalGraph, nodeIdentifier, inputEdges, newValue, alreadyMaterialized, batch) {
    revokeIncomingValidity(batch, nodeIdentifier, inputEdges);
    await invalidateDependentsFrom(incrementalGraph.storage, batch, nodeIdentifier);
    const datetime = incrementalGraph.datetime;
    const nowIso = datetime.now().toISOString();
    batch.values.put(nodeIdentifier, newValue);


    const existingTimestamp = await batch.timestamps.get(nodeIdentifier);
    if (alreadyMaterialized === true) {
        if (existingTimestamp === undefined) {
            throw new ReplicaStateInvariantError("pull", "has no timestamps entry", nodeIdentifierToString(nodeIdentifier));
        }
        batch.timestamps.put(nodeIdentifier, {
            createdAt: existingTimestamp.createdAt,
            modifiedAt: nowIso,
        });
    } else {
        batch.timestamps.put(nodeIdentifier, {
            createdAt: nowIso,
            modifiedAt: nowIso,
        });
    }

    addValidityFlags(batch, nodeIdentifier, inputEdges);
    batch.freshness.put(nodeIdentifier, "up-to-date");
}

/**
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {(nodeKeyStr: NodeKeyString) => Promise<ComputedValue>} pullDependency
 * @param {ResolvedConcreteNode} nodeDefinition
 * @param {Transaction} tx
 * @returns {Promise<RecomputeResult>}
 */
async function internalMaybeRecalculate(
    incrementalGraph,
    pullDependency,
    nodeDefinition,
    tx
) {
    const batch = tx.batch;
    const nodeIdentifier = nodeDefinition.outputIdentifier;
    const oldValue = await batch.values.get(nodeIdentifier);
    if (nodeDefinition.alreadyMaterialized === true && oldValue === undefined) {
        throw new ReplicaStateInvariantError("pull", "has no cached value", nodeIdentifierToString(nodeIdentifier));
    }

    /** @type {Array<ComputedValue>} */
    const inputValues = [];
    /** @type {NodeIdentifier[]} */
    const inputIdentifiers = [];

    for (let index = 0; index < nodeDefinition.inputKeys.length; index++) {
        const inputKey = nodeDefinition.inputKeys[index];
        if (inputKey === undefined) {
            throw new Error(`Missing input key for node ${nodeDefinition.outputKey}`);
        }
        const inputValue = await pullDependency(inputKey);
        inputValues.push(inputValue);

        const inputIdentifier = lookupNodeIdentifier(tx, inputKey);
        if (inputIdentifier === undefined) {
            throw new Error(
                `Missing identifier for input ${String(inputKey)} after pull`
            );
        }
        inputIdentifiers.push(inputIdentifier);
    }

    // inputIdentifiers are inputPositions (preserving duplicates for computor args).
    // inputEdges are the normalized structural dependency-edge list.
    const inputEdges = normalizeInputEdges(inputIdentifiers);

    const computedValue = await nodeDefinition.computor(inputValues, oldValue);

    if (isUnchanged(computedValue)) {
        if (oldValue === undefined) {
            throw makeInvalidUnchangedError(nodeDefinition.outputKey);
        }
    } else if (computedValue === null || computedValue === undefined) {
        throw makeInvalidComputorReturnValueError(
            nodeDefinition.outputKey,
            computedValue
        );
    }

    // Dependencies were pulled before the computor runs; their own pull transactions
    // establish up-to-date freshness and timestamps.

    if (isUnchanged(computedValue)) {
        await handleUnchanged(incrementalGraph, nodeIdentifier, inputEdges, batch);

        const result = await batch.values.get(nodeIdentifier);
        if (result === undefined) {
            throw makeInvalidUnchangedError(nodeDefinition.outputKey);
        }
        return { value: result, status: "unchanged" };
    }

    await handleChanged(incrementalGraph, nodeIdentifier, inputEdges, computedValue, nodeDefinition.alreadyMaterialized, batch);
    return { value: computedValue, status: "changed" };
}

module.exports = {
    internalMaybeRecalculate,
};
