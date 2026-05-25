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
    return async (inputs, _oldValue, _bindings, pull) => {
        const firstInput = inputs[0];
        if (!firstInput || firstInput.type !== "basic_context") {
            throw new Error("Expected first input of type basic_context for calories(e) computor");
        }
        // Use the pull callback to get ontology within the same transaction.
        // This avoids deadlock from calling graph.pull() which would try to
        // reacquire the mutex we're already holding.
        const ontologyValue = await pull("ontology");
        if (ontologyValue.type !== "ontology") {
            throw new Error(`Expected ontology entry but got type: ${ontologyValue.type}`);
        }
        const ontology = ontologyValue.ontology;
        return computeCaloriesForEvent(firstInput.eventId, firstInput.events, ontology, capabilities);
    };
}

module.exports = {
    makeComputor,
};
