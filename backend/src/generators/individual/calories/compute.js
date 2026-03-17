/**
 * Compute calorie estimates for individual events via an AI estimator.
 */

/** @typedef {import('../../incremental_graph/database/types').CaloriesEntry} CaloriesEntry */
/** @typedef {import('../../../event').SerializedEvent} SerializedEvent */
/** @typedef {import('../../../ai/calories').AICalories} AICalories */

/**
 * @typedef {object} CaloriesCapabilities
 * @property {AICalories} aiCalories - AI calories estimation capability.
 * @property {import('../../../logger').Logger} logger - Logger for debugging and informational messages.
 */

/**
 * Estimates the calorie count for the given event basic context.
 *
 * Joins all context inputs and delegates to the AI estimator
 * via capabilities. Returns 'N/A' when context is empty or when the AI
 * determines the entry has no meaningful calorie assignment (e.g. sleep, exercise).
 *
 * @param {Array<SerializedEvent>} contextEvents - The serialized basic context events
 * @param {CaloriesCapabilities} capabilities - Capabilities providing the AI estimator
 * @returns {Promise<CaloriesEntry>}
 */
async function computeCaloriesForEvent(contextEvents, capabilities) {
    if (contextEvents.length === 0) {
        capabilities.logger.logDebug(
            {},
            "computeCaloriesForEvent: context is empty, returning N/A"
        );
        return { type: "calories", value: "N/A" };
    }

    const inputText = contextEvents.map((event) => event.input).join("\n");
    capabilities.logger.logDebug(
        {
            context_size: contextEvents.length,
            input_text_length: inputText.length,
        },
        "Computing calories for event basic context",
    );
    const value = await capabilities.aiCalories.estimateCalories(inputText);
    capabilities.logger.logInfo(
        {
            context_size: contextEvents.length,
            input_text_length: inputText.length,
            estimated_calories: value,
        },
        "Estimated calories for event basic context",
    );
    return { type: "calories", value };
}

module.exports = {
    computeCaloriesForEvent,
};
