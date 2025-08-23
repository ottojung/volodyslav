const { transaction } = require("./transaction");
const { ensureAccessible } = require("./synchronize");
const memconst = require("../memconst");

/** @typedef {import('./types').RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */
/**
 * @template T 
 * @typedef {import("./transaction").Transformation<T>} Transformation 
 */

/**
 * @typedef {object} RuntimeStateStorage
 * @property {<T>(f: Transformation<T>) => Promise<T>} transaction - Transaction function for runtime state operations
 * @property {() => Promise<void>} ensureAccessible - Function to ensure runtime state storage is accessible
 */

/**
 * Creates a runtime state storage capability with transaction and ensureAccessible functions.
 * @param {() => RuntimeStateStorageCapabilities} getCapabilities - Function to get the capabilities object
 * @returns {RuntimeStateStorage}
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * @template T
     * @param {import("./transaction").Transformation<T>} transformation
     * @returns {Promise<T>}
     */
    function transactionWrapper(transformation) {
        return transaction(getCapabilitiesMemo(), transformation);
    }

    return {
        transaction: transactionWrapper,
        ensureAccessible: () => ensureAccessible(getCapabilitiesMemo()),
    };
}

module.exports = { make };
