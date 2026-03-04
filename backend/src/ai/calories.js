/**
 * @module ai_calories
 *
 * Purpose:
 *   This module provides a unified abstraction for AI-powered calorie estimation,
 *   decoupling direct OpenAI API calls from application logic.
 *
 * Why this Module Exists:
 *   Direct API calls can scatter configuration and error handling throughout the codebase.
 *   Centralizing calorie estimation logic here ensures a single place to manage API
 *   interactions, keeping application code clean and maintainable.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on estimating caloric content from entries.
 *   • Error Abstraction - Handles API-specific errors and provides consistent error types.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const { OpenAI } = require("openai");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

class AICaloriesError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AICaloriesError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AICaloriesError.
 * @param {unknown} object - The error to check.
 * @returns {object is AICaloriesError}
 */
function isAICaloriesError(object) {
    return object instanceof AICaloriesError;
}

const CALORIES_MODEL = "gpt-5.2";

const SYSTEM_PROMPT = `You are a nutrition assistant. Given a personal log entry, estimate the number of calories consumed.

Rules:
- If the entry describes food or drink consumption, return your best integer estimate of the total calories.
- If the entry contains no food or drink consumption (e.g. sleep, exercise, mood, tasks), return 0.
- Respond with a single integer and nothing else. No units, no explanation.`;

/**
 * @typedef {object} AICalories
 * @property {(entry: string) => Promise<number>} estimateCalories
 */

/**
 * Estimates the number of calories in a log entry.
 * @param {function(string): OpenAI} openai - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} entry - The log entry to analyse.
 * @returns {Promise<number>} - The estimated calorie count.
 */
async function estimateCalories(openai, capabilities, entry) {
    try {
        const apiKey = capabilities.environment.openaiAPIKey();
        const response = await openai(apiKey).chat.completions.create({
            model: CALORIES_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: entry },
            ],
        });
        const text = response.choices[0]?.message?.content?.trim() ?? "0";
        const calories = parseInt(text, 10);
        if (isNaN(calories)) {
            throw new AICaloriesError(
                `Model returned a non-numeric response: ${JSON.stringify(text)}`,
                undefined
            );
        }
        return calories;
    } catch (error) {
        if (isAICaloriesError(error)) {
            throw error;
        }
        throw new AICaloriesError(
            `Failed to estimate calories: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }
}

/**
 * Creates an AICalories capability.
 * @param {() => Capabilities} getCapabilities - A function returning the capabilities object.
 * @returns {AICalories} - The AI calories interface.
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const openai = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        estimateCalories: (entry) => estimateCalories(openai, getCapabilitiesMemo(), entry),
    };
}

module.exports = {
    make,
    isAICaloriesError,
};
