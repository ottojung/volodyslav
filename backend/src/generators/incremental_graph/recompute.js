/**
 * Recalculation helpers for IncrementalGraph.
 */

/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/**
 * @typedef {object} IncrementalGraphRecomputeAccess
 * @property {import('./graph_storage').GraphStorage} storage
 * @property {import('../../datetime').Datetime} datetime
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {(nodeKeyStr: import('./types').NodeKeyString) => Promise<RecomputeResult>} pullByNodeKeyStringWithStatus
 */

const { makeInvalidComputorReturnValueError, makeInvalidUnchangedError } = require("./errors");
const { deserializeNodeKey } = require("./node_key");
const { isUnchanged } = require("./unchanged");
const { nodeKeyStringToString } = require("./database");
/**
 * @param {IncrementalGraphRecomputeAccess} incrementalGraph
 * @param {ConcreteNode} nodeDefinition
 * @param {BatchBuilder} batch
 * @returns {Promise<RecomputeResult>}
 */
async function internalMaybeRecalculate(
    incrementalGraph,
    nodeDefinition,
    batch
) {
    const nodeKey = nodeDefinition.output;
    const oldValue = await batch.values.get(nodeKey);

    /** @type {Array<import('./database/types').ComputedValue>} */
    const inputValues = [];
    const currentInputCounters = [];

    for (const inputKey of nodeDefinition.inputs) {
        const { value: inputValue } =
            await incrementalGraph.pullByNodeKeyStringWithStatus(inputKey);
        inputValues.push(inputValue);

        const inputCounter = await batch.counters.get(inputKey);
        if (inputCounter === undefined) {
            throw new Error(`Missing counter for input ${inputKey} after pull`);
        }
        currentInputCounters.push(inputCounter);
    }

    if (nodeDefinition.inputs.length > 0 && oldValue !== undefined) {
        const inputsRecord = await batch.inputs.get(nodeKey);
        if (inputsRecord) {
            if (!inputsRecord.inputCounters) {
                throw new Error(
                    `Missing inputCounters in InputsRecord for node ${nodeKey}`
                );
            }
            if (inputsRecord.inputCounters.length !== nodeDefinition.inputs.length) {
                throw new Error(
                    `inputCounters length mismatch for node ${nodeKey}: ` +
                    `expected ${nodeDefinition.inputs.length}, got ${inputsRecord.inputCounters.length}`
                );
            }

            const storedInputs = inputsRecord.inputs;
            const currentInputs = nodeDefinition.inputs.map(nodeKeyStringToString);
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
                        nodeKey,
                        nodeDefinition.inputs,
                        batch
                    );
                    await incrementalGraph.storage.ensureMaterialized(
                        nodeKey,
                        nodeDefinition.inputs,
                        currentInputCounters,
                        batch
                    );
                    batch.freshness.put(nodeKey, "up-to-date");
                    return { value: oldValue, status: "cached" };
                }
            }
        }
    }

    const computedValue = await nodeDefinition.computor(inputValues, oldValue);
    if (isUnchanged(computedValue)) {
        if (oldValue === undefined) {
            throw makeInvalidUnchangedError(nodeKey);
        }
    } else if (computedValue === null || computedValue === undefined) {
        throw makeInvalidComputorReturnValueError(
            deserializeNodeKey(nodeKey).head,
            computedValue
        );
    }

    if (nodeDefinition.inputs.length > 0) {
        await incrementalGraph.storage.ensureReverseDepsIndexed(
            nodeKey,
            nodeDefinition.inputs,
            batch
        );
    }

    for (const inputKey of nodeDefinition.inputs) {
        batch.freshness.put(inputKey, "up-to-date");
    }

    if (isUnchanged(computedValue)) {
        const oldCounter = await batch.counters.get(nodeKey);
        if (oldCounter === undefined) {
            batch.counters.put(nodeKey, 1);
        }

        await incrementalGraph.storage.ensureMaterialized(
            nodeKey,
            nodeDefinition.inputs,
            currentInputCounters,
            batch
        );
        batch.freshness.put(nodeKey, "up-to-date");

        const result = await batch.values.get(nodeKey);
        if (result === undefined) {
            throw makeInvalidUnchangedError(nodeKey);
        }
        return { value: result, status: "unchanged" };
    }

    const oldCounter = await batch.counters.get(nodeKey);
    const newCounter = oldCounter !== undefined ? oldCounter + 1 : 1;
    batch.counters.put(nodeKey, newCounter);

    const nowIso = incrementalGraph.datetime.now().toISOString();
    if (oldCounter === undefined) {
        batch.timestamps.put(nodeKey, {
            createdAt: nowIso,
            modifiedAt: nowIso,
        });
    } else {
        const existingTimestamp = await batch.timestamps.get(nodeKey);
        const createdAt =
            existingTimestamp !== undefined
                ? existingTimestamp.createdAt
                : nowIso;
        batch.timestamps.put(nodeKey, { createdAt, modifiedAt: nowIso });
    }

    batch.values.put(nodeKey, computedValue);
    await incrementalGraph.storage.ensureMaterialized(
        nodeKey,
        nodeDefinition.inputs,
        currentInputCounters,
        batch
    );
    batch.freshness.put(nodeKey, "up-to-date");
    return { value: computedValue, status: "changed" };
}

module.exports = {
    internalMaybeRecalculate,
};
