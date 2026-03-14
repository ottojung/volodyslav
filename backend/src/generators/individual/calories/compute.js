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

const UNAVAILABLE_CALORIES = "N/A";

/**
 * Estimates the calorie count for the given event.
 *
 * Extracts the raw input text from the event and delegates to the AI estimator
 * via capabilities. Returns "N/A" when the event has no meaningful calorie
 * assignment.
 *
 * @param {Event | null} event - The full event object, or null if not found
 * @param {CaloriesCapabilities} capabilities - Capabilities providing the AI estimator
 * @returns {Promise<CaloriesEntry>}
 */
async function computeCaloriesForEvent(event, capabilities) {
    if (event === null) {
        capabilities.logger.logDebug({}, "computeCaloriesForEvent: event is null, returning unavailable calories");
        return { type: "calories", value: UNAVAILABLE_CALORIES };
    }

    const inputText = event.input ?? "";
    if (inputText.trim().length === 0) {
        capabilities.logger.logDebug(
            { event_id: event.id },
            "computeCaloriesForEvent: event input is empty, returning unavailable calories",
        );
        return { type: "calories", value: UNAVAILABLE_CALORIES };
    }

    const estimatedCalories = await capabilities.aiCalories.estimateCalories(inputText);
    const value = estimatedCalories > 0 ? estimatedCalories : UNAVAILABLE_CALORIES;
    capabilities.logger.logDebug(
        {
            event_id: event.id,
            input_text_length: inputText.length,
            estimated_calories: estimatedCalories,
            calories_value: value,
        },
        "Estimated calories for event",
    );
    return { type: "calories", value };
}

module.exports = {
    computeCaloriesForEvent,
};
