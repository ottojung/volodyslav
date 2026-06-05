/**
 * Recalculation helpers for IncrementalGraph.
 *
 * Transaction context is passed explicitly - no async_hooks or push/pop context.
 *
 * Async-boundary safety:
 * All awaits in this module are protected by GRAPH_ACTIVITY_KEY("pull") held
 * by the calling pullNode scope.  The Transaction object (tx) and its batch
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
 * @property {(nodeKeyStr: NodeKeyString) => Promise<ComputedValue>} _pullDuringPull
 */

const { makeInvalidComputorReturnValueError, makeInvalidUnchangedError } = require("./errors");
const { isUnchanged } = require("./unchanged");
const {
    nodeIdentifierToString,
    nodeIdentifierFromString,
    stringToNodeName,
    serializeNodeKey,
} = require("./database");
const { lookupNodeIdentifier } = require("./graph_state");

/**
 * Create a dependency accumulator for the materialized dependency record.
 * Static inputs are added before computation. Dynamic pulls append only newly
 * observed identifiers, so duplicate pulls of the same dependency keep one
 * counter entry and preserve the first-observed order.
 * @param {NodeIdentifier[]} inputIdentifiers
 * @param {number[]} inputCounters
 * @returns {{ identifiers: NodeIdentifier[], counters: number[], add: (identifier: NodeIdentifier, counter: number) => void }}
 */
function makeMaterializedDependencyAccumulator(inputIdentifiers, inputCounters) {
    /** @type {NodeIdentifier[]} */
    const identifiers = [];
    /** @type {number[]} */
    const counters = [];
    /** @type {Set<string>} */
    const seen = new Set();

    /**
     * @param {NodeIdentifier} identifier
     * @param {number} counter
     * @returns {void}
     */
    function add(identifier, counter) {
        const identifierString = nodeIdentifierToString(identifier);
        if (seen.has(identifierString)) {
            return;
        }
        seen.add(identifierString);
        identifiers.push(identifier);
        counters.push(counter);
    }

    for (let index = 0; index < inputIdentifiers.length; index++) {
        const inputIdentifier = inputIdentifiers[index];
        const inputCounter = inputCounters[index];
        if (inputIdentifier === undefined || inputCounter === undefined) {
            throw new Error(`Missing static dependency metadata at index ${String(index)}`);
        }
        add(inputIdentifier, inputCounter);
    }

    return { identifiers, counters, add };
}

/**
 * Return true when an existing materialized inputs record exactly matches the
 * dependencies and counters observed for this recomputation.
 * @param {import('./database/types').InputsRecord} inputsRecord
 * @param {NodeIdentifier[]} currentInputIdentifiers
 * @param {number[]} currentInputCounters
 * @returns {boolean}
 */
function materializedInputsMatch(inputsRecord, currentInputIdentifiers, currentInputCounters) {
    if (!inputsRecord.inputCounters) {
        throw new Error("Missing inputCounters in InputsRecord");
    }
    if (inputsRecord.inputCounters.length !== currentInputCounters.length) {
        return false;
    }

    const storedInputs = inputsRecord.inputs;
    const currentInputs = currentInputIdentifiers.map(nodeIdentifierToString);
    if (storedInputs.length !== currentInputs.length) {
        return false;
    }
    for (let index = 0; index < storedInputs.length; index++) {
        if (storedInputs[index] !== currentInputs[index]) {
            return false;
        }
        if (inputsRecord.inputCounters[index] !== currentInputCounters[index]) {
            return false;
        }
    }
    return true;
}

/**
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {ResolvedConcreteNode} nodeDefinition
 * @param {Transaction} tx
 * @param {(diff: import('./graph_state').RevdepDiff) => void} reportRevdepDiff
 * @returns {Promise<RecomputeResult>}
 */
async function internalMaybeRecalculate(
    incrementalGraph,
    nodeDefinition,
    tx,
    reportRevdepDiff
) {
    const batch = tx.batch;
    const nodeIdentifier = nodeDefinition.outputIdentifier;
    const oldValue = await batch.values.get(nodeIdentifier);

    /** @type {Array<ComputedValue>} */
    const inputValues = [];
    /** @type {number[]} */
    const currentInputCounters = [];
    /** @type {NodeIdentifier[]} */
    const inputIdentifiers = [];

    for (let index = 0; index < nodeDefinition.inputKeys.length; index++) {
        const inputKey = nodeDefinition.inputKeys[index];
        if (inputKey === undefined) {
            throw new Error(`Missing input key for node ${nodeDefinition.outputKey}`);
        }
        const inputValue =
            await incrementalGraph._pullDuringPull(inputKey);
        inputValues.push(inputValue);

        const inputIdentifier = lookupNodeIdentifier(tx, inputKey);
        if (inputIdentifier === undefined) {
            throw new Error(
                `Missing identifier for input ${String(inputKey)} after pull`
            );
        }
        inputIdentifiers.push(inputIdentifier);

        const inputCounter = await batch.counters.get(inputIdentifier);
        if (inputCounter === undefined) {
            throw new Error(
                `Missing counter for input ${nodeIdentifierToString(inputIdentifier)} after pull`
            );
        }
        currentInputCounters.push(inputCounter);
    }

    const materializedDependencies = makeMaterializedDependencyAccumulator(
        inputIdentifiers,
        currentInputCounters
    );

    if (materializedDependencies.identifiers.length > 0 && oldValue !== undefined) {
        const inputsRecord = await batch.inputs.get(nodeIdentifier);
        if (inputsRecord && materializedInputsMatch(
            inputsRecord,
            materializedDependencies.identifiers,
            materializedDependencies.counters
        )) {
            await incrementalGraph.storage.ensureMaterialized(
                nodeIdentifier,
                materializedDependencies.identifiers,
                materializedDependencies.counters,
                batch
            );
            batch.freshness.put(nodeIdentifier, "up-to-date");
            return { value: oldValue, status: "cached" };
        }
    }

    // Create a pull callback bound to the current transaction.
    // Computors must use this callback for any dynamic dependencies rather
    // than calling the graph's public pull method (which would deadlock).
    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue>}
     */
    const pullCallback = async (nodeName, bindings = []) => {
        const nodeKey = { head: stringToNodeName(nodeName), args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);
        const inputValue = await incrementalGraph._pullDuringPull(concreteKey);
        const dynamicIdentifier = lookupNodeIdentifier(tx, concreteKey);
        if (dynamicIdentifier === undefined) {
            throw new Error(`Missing identifier for dynamically pulled node ${String(concreteKey)}`);
        }
        const dynamicCounter = await batch.counters.get(dynamicIdentifier);
        if (dynamicCounter === undefined) {
            throw new Error(
                `Missing counter for dynamically pulled input ${nodeIdentifierToString(dynamicIdentifier)} after pull`
            );
        }
        materializedDependencies.add(dynamicIdentifier, dynamicCounter);
        return inputValue;
    };

    // Execute the computor. Pass the pull callback so the computor can
    // pull additional dependencies using the current transaction.
    const computedValue = await nodeDefinition.computor(inputValues, oldValue, pullCallback);

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

    // Collect revdep diff — applied during commit phase under commit mutex
    const oldInputsRecord = await batch.inputs.get(nodeIdentifier);
    const oldDependencies = (oldInputsRecord?.inputs ?? []).map(nodeIdentifierFromString);
    reportRevdepDiff({
        dependant: nodeIdentifier,
        oldDependencies,
        newDependencies: materializedDependencies.identifiers,
    });

    for (const inputIdentifier of materializedDependencies.identifiers) {
        batch.freshness.put(inputIdentifier, "up-to-date");
    }

    if (isUnchanged(computedValue)) {
        const oldCounter = await batch.counters.get(nodeIdentifier);
        if (oldCounter === undefined) {
            batch.counters.put(nodeIdentifier, 1);
        }

        await incrementalGraph.storage.ensureMaterialized(
            nodeIdentifier,
            materializedDependencies.identifiers,
            materializedDependencies.counters,
            batch
        );
        batch.freshness.put(nodeIdentifier, "up-to-date");

        const result = await batch.values.get(nodeIdentifier);
        if (result === undefined) {
            throw makeInvalidUnchangedError(nodeDefinition.outputKey);
        }
        return { value: result, status: "unchanged" };
    }

    const oldCounter = await batch.counters.get(nodeIdentifier);
    const newCounter = oldCounter !== undefined ? oldCounter + 1 : 1;
    batch.counters.put(nodeIdentifier, newCounter);

    const nowIso = incrementalGraph.datetime.now().toISOString();
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

    batch.values.put(nodeIdentifier, computedValue);
    await incrementalGraph.storage.ensureMaterialized(
        nodeIdentifier,
        materializedDependencies.identifiers,
        materializedDependencies.counters,
        batch
    );
    batch.freshness.put(nodeIdentifier, "up-to-date");
    return { value: computedValue, status: "changed" };
}

module.exports = {
    internalMaybeRecalculate,
};
