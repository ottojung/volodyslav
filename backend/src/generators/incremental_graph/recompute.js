/**
 * Recalculation helpers for IncrementalGraph.
 *
 * Transaction context is passed explicitly - no async_hooks or push/pop context.
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ResolvedConcreteNode} ResolvedConcreteNode */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */

/**
 * @typedef {object} IncrementalGraphRecomputeAccess
 * @property {import('./graph_state').GraphStorage} storage
 * @property {import('../../datetime').Datetime} datetime
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {(nodeKeyStr: import('./types').NodeKeyString, tx: Transaction) => Promise<RecomputeResult>} _pullDuringPull
 */

const { makeInvalidComputorReturnValueError, makeInvalidUnchangedError } = require("./errors");
const { isUnchanged } = require("./unchanged");
const { nodeIdentifierToString, stringToNodeName, serializeNodeKey, txNodeKeyToId } = require("./database");

/**
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {ResolvedConcreteNode} nodeDefinition
 * @param {Transaction} tx
 * @returns {Promise<RecomputeResult>}
 */
async function internalMaybeRecalculate(
    incrementalGraph,
    nodeDefinition,
    tx
) {
    const batch = tx.batch;
    const nodeIdentifier = nodeDefinition.outputIdentifier;
    const oldValue = await batch.values.get(nodeIdentifier);

    /** @type {Array<import('./database/types').ComputedValue>} */
    const inputValues = [];
    const currentInputCounters = [];

    for (let index = 0; index < nodeDefinition.inputKeys.length; index++) {
        const inputKey = nodeDefinition.inputKeys[index];
        const inputIdentifier = nodeDefinition.inputIdentifiers[index];
        if (inputKey === undefined || inputIdentifier === undefined) {
            throw new Error(`Missing input identifier for node ${nodeDefinition.outputKey}`);
        }
        const { value: inputValue } =
            await incrementalGraph._pullDuringPull(inputKey, tx);
        inputValues.push(inputValue);

        const canonicalInputIdentifier =
            txNodeKeyToId(tx.identifierLookup, inputKey) ?? inputIdentifier;
        nodeDefinition.inputIdentifiers[index] = canonicalInputIdentifier;

        const inputCounter = await batch.counters.get(canonicalInputIdentifier);
        if (inputCounter === undefined) {
            if (tx.reservedIdentifiers.size > 0) {
                currentInputCounters.push(0);
            } else {
                throw new Error(
                    `Missing counter for input ${nodeIdentifierToString(canonicalInputIdentifier)} after pull`
                );
            }
        } else {
            currentInputCounters.push(inputCounter);
        }
    }

    if (nodeDefinition.inputIdentifiers.length > 0 && oldValue !== undefined) {
        const inputsRecord = await batch.inputs.get(nodeIdentifier);
        if (inputsRecord) {
            if (!inputsRecord.inputCounters) {
                throw new Error(
                    `Missing inputCounters in InputsRecord for node ${nodeDefinition.outputKey}`
                );
            }
            if (inputsRecord.inputCounters.length !== nodeDefinition.inputIdentifiers.length) {
                throw new Error(
                    `inputCounters length mismatch for node ${nodeDefinition.outputKey}: ` +
                    `expected ${nodeDefinition.inputIdentifiers.length}, got ${inputsRecord.inputCounters.length}`
                );
            }

            const storedInputs = inputsRecord.inputs;
            const currentInputs = nodeDefinition.inputIdentifiers.map(
                nodeIdentifierToString
            );
            let inputsMatch = storedInputs.length === currentInputs.length;
            if (inputsMatch) {
                for (let index = 0; index < storedInputs.length; index++) {
                    if (storedInputs[index] !== currentInputs[index]) {
                        inputsMatch = false;
                        break;
                    }
                }
            }

            if (inputsMatch) {
                let countersMatch = true;
                for (
                    let index = 0;
                    index < currentInputCounters.length;
                    index++
                ) {
                    if (
                        currentInputCounters[index] !==
                        inputsRecord.inputCounters[index]
                    ) {
                        countersMatch = false;
                        break;
                    }
                }

                if (countersMatch) {
                    await incrementalGraph.storage.ensureReverseDepsIndexed(
                        nodeIdentifier,
                        nodeDefinition.inputIdentifiers,
                        batch
                    );
                    await incrementalGraph.storage.ensureMaterialized(
                        nodeIdentifier,
                        nodeDefinition.inputIdentifiers,
                        currentInputCounters,
                        batch
                    );
                    batch.freshness.put(nodeIdentifier, "up-to-date");
                    return { value: oldValue, status: "cached" };
                }
            }
        }
    }

    // Create a pull callback bound to the current transaction.
    // Computors must use this callback for any dynamic dependencies rather
    // than calling the graph's public pull method (which would deadlock).
    /**
     * @param {string} nodeName
     * @param {Array<import('./types').ConstValue>} [bindings=[]]
     * @returns {Promise<import('./types').ComputedValue>}
     */
    const pullCallback = async (nodeName, bindings = []) => {
        const nodeKey = { head: stringToNodeName(nodeName), args: bindings };
        const concreteKey = serializeNodeKey(nodeKey);
        const result = await incrementalGraph._pullDuringPull(concreteKey, tx);
        return result.value;
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

    if (nodeDefinition.inputIdentifiers.length > 0) {
        await incrementalGraph.storage.ensureReverseDepsIndexed(
            nodeIdentifier,
            nodeDefinition.inputIdentifiers,
            batch
        );
    }

    for (const inputIdentifier of nodeDefinition.inputIdentifiers) {
        batch.freshness.put(inputIdentifier, "up-to-date");
    }

    if (isUnchanged(computedValue)) {
        const oldCounter = await batch.counters.get(nodeIdentifier);
        if (oldCounter === undefined) {
            batch.counters.put(nodeIdentifier, 1);
        }

        await incrementalGraph.storage.ensureMaterialized(
            nodeIdentifier,
            nodeDefinition.inputIdentifiers,
            currentInputCounters,
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
        nodeDefinition.inputIdentifiers,
        currentInputCounters,
        batch
    );
    batch.freshness.put(nodeIdentifier, "up-to-date");
    return { value: computedValue, status: "changed" };
}

module.exports = {
    internalMaybeRecalculate,
};
