const { transaction } = require("./transaction");
const { ensureAccessible } = require("./synchronize");

/** @typedef {import('./types').RuntimeStateStorageCapabilities} RuntimeStateStorageCapabilities */

/**
 * @typedef {object} RuntimeStateStorage
 * @property {typeof transaction} transaction - Transaction function for runtime state operations
 * @property {typeof ensureAccessible} ensureAccessible - Function to ensure runtime state storage is accessible
 */

/**
 * Creates a runtime state storage capability with transaction and ensureAccessible functions.
 * @param {() => RuntimeStateStorageCapabilities} getCapabilities - Function to get the capabilities object
 * @returns {RuntimeStateStorage}
 */
function make(getCapabilities) {
    return {
        transaction: (transformation) => transaction(getCapabilities(), transformation),
        ensureAccessible: () => ensureAccessible(getCapabilities()),
    };
}

module.exports = { make };
