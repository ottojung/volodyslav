/**
 * Compute calorie estimates for individual events via an AI estimator.
 */

/** @typedef {import('../../incremental_graph/database/types').CaloriesEntry} CaloriesEntry */
/** @typedef {import('../../../event').SerializedEvent} SerializedEvent */
/** @typedef {import('../../../ai/calories').AICalories} AICalories */
/** @typedef {import('../../../ontology/structure').Ontology} Ontology */

/**
 * @typedef {object} CaloriesCapabilities
 * @property {AICalories} aiCalories - AI calories estimation capability.
 * @property {import('../../../logger').Logger} logger - Logger for debugging and informational messages.
 */

/**
 * Estimates the calorie count for the given event basic context.
 *
 * Delegates the target event and raw basic context to the AI estimator.
 * Returns 'N/A' when context is empty or when the AI
 * determines the entry has no meaningful calorie assignment (e.g. sleep, exercise).
 *
 * @param {string} targetEventId - The event ID whose calories are being estimated
 * @param {Array<SerializedEvent>} contextEvents - The serialized basic context events
 * @param {Ontology | null} ontology - Optional ontology for richer AI context
 * @param {CaloriesCapabilities} capabilities - Capabilities providing the AI estimator
 * @returns {Promise<CaloriesEntry>}
 */
async function computeCaloriesForEvent(targetEventId, contextEvents, ontology, capabilities) {
    if (contextEvents.length === 0) {
        capabilities.logger.logDebug(
            {},
            "computeCaloriesForEvent: context is empty, returning N/A"
        );
        return { type: "calories", value: "N/A" };
    }

    const targetEvent = contextEvents.find((event) => event.id === targetEventId);
    if (targetEvent === undefined) {
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
            target_event_input_length: targetEvent.input.length,
        },
        "Computing calories for event basic context",
    );
    const value = await capabilities.aiCalories.estimateCalories(targetEvent, contextEvents, ontology);
    capabilities.logger.logInfo(
        {
            target_event_id: targetEventId,
            context_size: contextEvents.length,
            estimated_calories: value,
        },
        "Estimated calories for event basic context",
    );
    return { type: "calories", value };
}

module.exports = {
    computeCaloriesForEvent,
};
