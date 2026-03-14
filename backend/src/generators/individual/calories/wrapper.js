const { deserialize } = require("../../../event");
const { computeCaloriesForEvent } = require("./compute");

/**
 * @typedef {import('./compute').CaloriesCapabilities} CaloriesCapabilities
 */

/**
 * @param {CaloriesCapabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (inputs, _oldValue, _bindings) => {
        const firstInput = inputs[0];
        if (!firstInput || firstInput.type !== "event") {
            throw new Error("Expected input of type event for calories(e) computor");
        }
        const ev = deserialize(firstInput.value);
        return computeCaloriesForEvent(ev, capabilities);
    };
}

module.exports = {
    makeComputor,
};
