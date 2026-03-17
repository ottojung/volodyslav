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
 * Builds a structured AI prompt input from a target event and its basic context.
 *
 * @param {string} targetEventId
 * @param {Array<SerializedEvent>} contextEvents
 * @returns {string}
 */
function buildCaloriesPromptInput(targetEventId, contextEvents) {
    const targetEvent = contextEvents.find((event) => event.id === targetEventId);
    if (targetEvent === undefined) {
        return "";
    }

    const relatedContext = contextEvents.filter((event) => event.id !== targetEventId);
    const relatedContextBlock = relatedContext.length === 0
        ? "- none"
        : relatedContext
            .map((event, index) => `${index + 1}. ${event.input}`)
            .join("\n");

    return [
        "Target event:",
        targetEvent.input,
        "",
        "Basic context (related events for disambiguation only):",
        relatedContextBlock,
    ].join("\n");
}

/**
 * Estimates the calorie count for the given event basic context.
 *
 * Builds structured prompt input and delegates to the AI estimator
 * via capabilities. Returns 'N/A' when context is empty or when the AI
 * determines the entry has no meaningful calorie assignment (e.g. sleep, exercise).
 *
 * @param {string} targetEventId - The event ID whose calories are being estimated
 * @param {Array<SerializedEvent>} contextEvents - The serialized basic context events
 * @param {CaloriesCapabilities} capabilities - Capabilities providing the AI estimator
 * @returns {Promise<CaloriesEntry>}
 */
async function computeCaloriesForEvent(targetEventId, contextEvents, capabilities) {
    if (contextEvents.length === 0) {
        capabilities.logger.logDebug(
            {},
            "computeCaloriesForEvent: context is empty, returning N/A"
        );
        return { type: "calories", value: "N/A" };
    }

    const inputText = buildCaloriesPromptInput(targetEventId, contextEvents);
    if (inputText === "") {
        capabilities.logger.logDebug(
            { target_event_id: targetEventId },
            "computeCaloriesForEvent: target event missing from context, returning N/A"
        );
        return { type: "calories", value: "N/A" };
    }

    capabilities.logger.logDebug(
        {
            target_event_id: targetEventId,
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
    buildCaloriesPromptInput,
    computeCaloriesForEvent,
};
