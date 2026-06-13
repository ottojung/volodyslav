/**
 * Recalculation helpers for IncrementalGraph — flag-based inverse validity.
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
    compareNodeIdentifier,
} = require("./database");
const { lookupNodeIdentifier } = require("./graph_state");
const { readInputRecord } = require("./database");

/**
 * Create a dependency accumulator for the materialized dependency record.
 * @param {NodeIdentifier[]} inputIdentifiers
 * @returns {NodeIdentifier[]}
 */
function normalizeInputEdges(inputIdentifiers) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {NodeIdentifier[]} */
    const edges = [];
    for (const id of inputIdentifiers) {
        const idStr = nodeIdentifierToString(id);
        if (!seen.has(idStr)) {
            seen.add(idStr);
            edges.push(id);
        }
    }
    return edges;
}

/**
 * Compare two NodeIdentifier arrays for element-wise equality.
 * @param {NodeIdentifier[]} a
 * @param {NodeIdentifier[]} b
 * @returns {boolean}
 */
function arraysOfNodeIdentifiersEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const aId = a[i];
        const bId = b[i];
        if (aId === undefined || bId === undefined) return false;
        if (nodeIdentifierToString(aId) !== nodeIdentifierToString(bId)) return false;
    }
    return true;
}

/**
 * Read the current valid set for a dependency, returning empty array if none exists.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} depId
 * @returns {Promise<NodeIdentifier[]>}
 */
async function getValidSet(batch, depId) {
    return (await batch.valid.get(depId)) ?? [];
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
 * Maintains sorted order for deterministic storage.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} nId
 * @param {NodeIdentifier[]} inputEdges
 * @returns {Promise<void>}
 */
async function addValidityFlags(batch, nId, inputEdges) {
    const nIdStr = nodeIdentifierToString(nId);
    for (const depId of inputEdges) {
        const current = await getValidSet(batch, depId);
        if (current.some(id => nodeIdentifierToString(id) === nIdStr)) {
            continue;
        }
        current.push(nId);
        current.sort(compareNodeIdentifier);
        batch.valid.put(depId, current);
    }
}

/**
 * Propagate potentially-outdated freshness through revdeps[N].
 * Uses an iterative worklist to avoid stack overflow on deep chains.
 * @param {import('./graph_state').GraphStorage} storage
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} changedIdentifier
 * @returns {Promise<void>}
 */
async function propagateOutdatedFrom(storage, batch, changedIdentifier) {
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {NodeIdentifier[]} */
    const worklist = [changedIdentifier];

    while (worklist.length > 0) {
        const current = worklist.pop();
        if (current === undefined) continue;
        const currentStr = nodeIdentifierToString(current);
        if (visited.has(currentStr)) continue;
        visited.add(currentStr);

        const dependents = await storage.listDependents(current, batch);
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
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeIdentifier[]} inputEdges
 * @param {BatchBuilder} batch
 * @returns {Promise<void>}
 */
async function handleUnchanged(incrementalGraph, nodeIdentifier, inputEdges, batch) {
    await incrementalGraph.storage.ensureMaterialized(nodeIdentifier, inputEdges, batch);
    await incrementalGraph.storage.ensureReverseDepsIndexed(nodeIdentifier, inputEdges, batch);
    await addValidityFlags(batch, nodeIdentifier, inputEdges);
    batch.freshness.put(nodeIdentifier, "up-to-date");
}

/**
 * Handle changed value computor result: clear old validity, write new value, record new flags.
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeIdentifier[]} inputEdges
 * @param {ComputedValue} newValue
 * @param {BatchBuilder} batch
 * @returns {Promise<void>}
 */
async function handleChanged(incrementalGraph, nodeIdentifier, inputEdges, newValue, batch) {
    // Remove N from union of persisted old edges and current edges.
    // Schema-derived edges are immutable in normal operation.
    const oldInputsRecord = await batch.inputs.get(nodeIdentifier);
    const oldEdges = readInputRecord(oldInputsRecord);
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {NodeIdentifier[]} */
    const allEdgesToClear = [];
    for (const edge of [...inputEdges, ...oldEdges]) {
        const str = nodeIdentifierToString(edge);
        if (!seen.has(str)) {
            seen.add(str);
            allEdgesToClear.push(edge);
        }
    }
    for (const depId of allEdgesToClear) {
        const current = (await batch.valid.get(depId)) ?? [];
        const filtered = current.filter(id => nodeIdentifierToString(id) !== nodeIdentifierToString(nodeIdentifier));
        if (filtered.length === 0) {
            batch.valid.del(depId);
        } else if (filtered.length < current.length) {
            batch.valid.put(depId, filtered);
        }
    }
    batch.valid.del(nodeIdentifier);

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

    await incrementalGraph.storage.ensureMaterialized(nodeIdentifier, inputEdges, batch);
    await incrementalGraph.storage.ensureReverseDepsIndexed(nodeIdentifier, inputEdges, batch);
    await addValidityFlags(batch, nodeIdentifier, inputEdges);
    batch.freshness.put(nodeIdentifier, "up-to-date");
    await propagateOutdatedFrom(incrementalGraph.storage, batch, nodeIdentifier);
}

/**
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {(nodeKeyStr: NodeKeyString) => Promise<ComputedValue>} pullDependency
 * @param {ResolvedConcreteNode} nodeDefinition
 * @param {Transaction} tx
 * @param {(diff: import('./graph_state').RevdepDiff) => void} reportRevdepDiff
 * @returns {Promise<RecomputeResult>}
 */
async function internalMaybeRecalculate(
    incrementalGraph,
    pullDependency,
    nodeDefinition,
    tx,
    reportRevdepDiff
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
            const persistedInputs = await batch.inputs.get(nodeIdentifier);
            if (persistedInputs === undefined) {
                throw new Error(
                    `Missing inputs record for node ${String(nodeDefinition.outputKey)}: ` +
                    `a materialized node must have an inputs record`
                );
            }
            if (!Array.isArray(persistedInputs)) {
                throw new Error(
                    `Malformed inputs record for node ${String(nodeDefinition.outputKey)}: ` +
                    `expected NodeIdentifier[], got ${typeof persistedInputs}`
                );
            }
            if (!arraysOfNodeIdentifiersEqual(persistedInputs, inputEdges)) {
                throw new Error(
                    `Corrupted inputs record for node ${String(nodeDefinition.outputKey)}: ` +
                    `persisted inputs differ from schema-derived inputEdges`
                );
            }
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

    // Collect revdep diff for darkroom finalization
    const oldInputsRecord = await batch.inputs.get(nodeIdentifier);
    const oldDependencies = readInputRecord(oldInputsRecord);
    reportRevdepDiff({
        dependant: nodeIdentifier,
        oldDependencies,
        newDependencies: inputEdges,
    });

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
