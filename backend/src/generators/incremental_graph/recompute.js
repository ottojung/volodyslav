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
} = require("./database");
const { lookupNodeIdentifier } = require("./graph_state");
const { normalizeInputEdges } = require("./database");

/**
 * Read the current valid set for a dependency from the mutation-aware batch.
 * Returns the database value merged with pending transaction-local mutations.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} depId
 * @returns {Promise<NodeIdentifier[]>}
 */
async function getValidSet(batch, depId) {
    return await batch.valid.get(depId);
}

/**
 * Returns true when every dependency in inputEdges has a validity flag for N.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} nId
 * @param {NodeIdentifier[]} inputEdges
 * @returns {Promise<boolean>}
 */
async function allValidityFlagsPresent(batch, nId, inputEdges) {
    if (inputEdges.length === 0) {
        return false;
    }
    const nIdStr = nodeIdentifierToString(nId);
    for (const depId of inputEdges) {
        const validSet = await getValidSet(batch, depId);
        if (!validSet.some(id => nodeIdentifierToString(id) === nIdStr)) {
            return false;
        }
    }
    return true;
}

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
 * Propagate potentially-outdated freshness through validity sets.
 * Uses an iterative worklist to avoid stack overflow on deep chains.
 * @param {import('./graph_state').GraphStorage} storage
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} changedIdentifier
 * @param {NodeIdentifier[]} [initialDependents]
 * @returns {Promise<void>}
 */
async function propagateOutdatedFrom(storage, batch, changedIdentifier, initialDependents = undefined) {
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {NodeIdentifier[]} */
    const worklist = initialDependents === undefined ? [changedIdentifier] : [...initialDependents];

    while (worklist.length > 0) {
        const current = worklist.pop();
        if (current === undefined) continue;
        const currentStr = nodeIdentifierToString(current);
        if (visited.has(currentStr)) continue;
        visited.add(currentStr);

        const dependents = await storage.getValid(current, batch);
        for (const dep of dependents) {
            const depStr = nodeIdentifierToString(dep);
            if (visited.has(depStr)) continue;
            const freshness = await batch.freshness.get(dep);
            if (freshness === "up-to-date") {
                batch.freshness.put(dep, "potentially-outdated");
                worklist.push(dep);
            }
        }
    }
}

/**
 * Handle Unchanged computor result: add validity flags, preserve counter and valid[N].
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
 * @param {BatchBuilder} batch
 * @returns {Promise<void>}
 */
async function handleChanged(incrementalGraph, nodeIdentifier, inputEdges, newValue, batch) {
    for (const edge of inputEdges) {
        batch.valid.remove(edge, nodeIdentifier);
    }
    const downstream = await getValidSet(batch, nodeIdentifier);
    batch.valid.clear(nodeIdentifier);
    for (const dependent of downstream) {
        const freshness = await batch.freshness.get(dependent);
        if (freshness === "up-to-date") {
            batch.freshness.put(dependent, "potentially-outdated");
        }
    }
    await propagateOutdatedFrom(incrementalGraph.storage, batch, nodeIdentifier, downstream);

    batch.values.put(nodeIdentifier, newValue);

    const oldCounter = await batch.counters.get(nodeIdentifier);
    const newCounter = oldCounter !== undefined ? oldCounter + 1 : 1;
    batch.counters.put(nodeIdentifier, newCounter);

    const datetime = incrementalGraph.datetime;
    const nowIso = datetime.now().toISOString();
    if (oldCounter === undefined) {
        batch.timestamps.put(nodeIdentifier, {
            createdAt: nowIso,
            modifiedAt: nowIso,
        });
    } else {
        const existingTimestamp = await batch.timestamps.get(nodeIdentifier);
        const createdAt =
            existingTimestamp !== undefined
                ? existingTimestamp.createdAt
                : nowIso;
        batch.timestamps.put(nodeIdentifier, { createdAt, modifiedAt: nowIso });
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

    // Cache predicate: reuse materialized value iff:
    // 1. materialized value exists,
    // 2. inputEdges is non-empty,
    // 3. valid[D].has(N) for every D in inputEdges.
    if (oldValue !== undefined && inputEdges.length > 0) {
        if (await allValidityFlagsPresent(batch, nodeIdentifier, inputEdges)) {
            batch.freshness.put(nodeIdentifier, "up-to-date");
            return { value: oldValue, status: "cached" };
        }
    }

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

    // Mark all dependencies as up-to-date
    for (const inputIdentifier of inputEdges) {
        batch.freshness.put(inputIdentifier, "up-to-date");
    }

    if (isUnchanged(computedValue)) {
        await handleUnchanged(incrementalGraph, nodeIdentifier, inputEdges, batch);

        const result = await batch.values.get(nodeIdentifier);
        if (result === undefined) {
            throw makeInvalidUnchangedError(nodeDefinition.outputKey);
        }
        return { value: result, status: "unchanged" };
    }

    await handleChanged(incrementalGraph, nodeIdentifier, inputEdges, computedValue, batch);
    return { value: computedValue, status: "changed" };
}

module.exports = {
    internalMaybeRecalculate,
};
