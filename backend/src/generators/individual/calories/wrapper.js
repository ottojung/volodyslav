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
        if (!firstInput || firstInput.type !== "basic_context") {
            throw new Error("Expected input of type basic_context for calories(e) computor");
        }
        return computeCaloriesForEvent(firstInput.events, capabilities);
    };
}

module.exports = {
    makeComputor,
};
