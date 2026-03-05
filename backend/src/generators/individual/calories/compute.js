/**
 * Compute calorie estimates for individual events via an AI estimator.
 */

/** @typedef {import('../../incremental_graph/database/types').CaloriesEntry} CaloriesEntry */
/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../../ai/calories').AICalories} AICalories */

/**
 * @typedef {object} CaloriesCapabilities
 * @property {AICalories} aiCalories - AI calories estimation capability.
 * @property {import('../../../logger').Logger} logger - Logger for debugging and informational messages.
 */

/**
 * Estimates the calorie count for the given event.
 *
 * Extracts the raw input text from the event and delegates to the AI estimator
 * via capabilities. Returns 0 calories when the event is null or its input
 * text is empty.
 *
 * @param {Event | null} event - The full event object, or null if not found
 * @param {CaloriesCapabilities} capabilities - Capabilities providing the AI estimator
 * @returns {Promise<CaloriesEntry>}
 */
async function computeCaloriesForEvent(event, capabilities) {
    const inputText = event?.input ?? "";
    const value = await capabilities.aiCalories.estimateCalories(inputText);
    capabilities.logger.logDebug(
        {
            event_id: event?.id,
            input_text_length: inputText.length,
            estimated_calories: value,
        },
        "Estimated calories for event",
    );
    return { type: "calories", value };
}

module.exports = {
    computeCaloriesForEvent,
};
