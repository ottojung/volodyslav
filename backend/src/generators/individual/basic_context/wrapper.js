const { computeBasicContextForEventId } = require("./compute");

/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, oldValue, bindings) => {
    const firstInput = inputs[0];
    if (!firstInput || firstInput.type !== "all_events") {
        throw new Error("Expected input of type all_events for basic_context(e) computor");
    }
    const allEvents = firstInput.events;

    const firstBinding = bindings[0];
    if (firstBinding === undefined || typeof firstBinding !== "string") {
        throw new Error(
            "Expected first binding to be a string for basic_context(e) computor, got " +
                JSON.stringify(firstBinding)
        );
    }
    if (oldValue !== undefined && oldValue.type !== "basic_context") {
        throw new Error(
            "Expected oldValue to be of type basic_context or undefined for basic_context(e) computor, got " +
                JSON.stringify(oldValue)
        );
    }
    return computeBasicContextForEventId(firstBinding, oldValue, allEvents);
};

module.exports = {
    computor,
};
