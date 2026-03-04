/**
 * Compute calorie estimates for individual events via an AI estimator.
 */

/** @typedef {import('../../incremental_graph/database/types').CaloriesEntry} CaloriesEntry */

/**
 * Estimates the calorie count for the given raw entry input text.
 *
 * Delegates entirely to the provided AI estimator so this module contains no
 * business logic — it is a pure thin adapter that translates the raw string
 * into the typed CaloriesEntry database value.
 *
 * Returns 0 calories when the input text is empty (no meaningful content to
 * send to the AI).
 *
 * @param {string} inputText - The raw input text of the event
 * @param {(text: string) => Promise<number>} estimateCalories - AI calories estimator
 * @returns {Promise<CaloriesEntry>}
 */
async function computeCaloriesForInput(inputText, estimateCalories) {
    if (!inputText) {
        return { type: "calories", value: 0 };
    }
    const value = await estimateCalories(inputText);
    return { type: "calories", value };
}

module.exports = {
    computeCaloriesForInput,
};
