const { computeCaloriesForEvent } = require("./compute");

/**
 * @typedef {import('./compute').CaloriesCapabilities} CaloriesCapabilities
 */

/**
 * @typedef {CaloriesCapabilities & {
 *   interface: import('../../interface').Interface
 * }} WrapperCapabilities
 */

/**
 * @param {WrapperCapabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (inputs, _oldValue, _bindings) => {
        const firstInput = inputs[0];
        if (!firstInput || firstInput.type !== "basic_context") {
            throw new Error("Expected first input of type basic_context for calories(e) computor");
        }
        // getOntology() reads from the interface/incremental graph and benefits from
        // graph-level caching, while intentionally not making ontology a direct
        // dependency edge of calories(e).
        const ontology = await capabilities.interface.getOntology();
        return computeCaloriesForEvent(firstInput.eventId, firstInput.events, ontology, capabilities);
    };
}

module.exports = {
    makeComputor,
};
