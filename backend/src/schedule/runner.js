/**
 * Legacy scheduler runner - deprecated.
 * This file is kept for backward compatibility but should not be used.
 * Use the declarative scheduler's initialize() function instead.
 * 
 * @param {import('../capabilities/root').Capabilities} _capabilities
 * @param {string} _name
 * @param {string} _cronExpression
 * @param {() => Promise<void>} _callback
 * @param {import('../time_duration/structure').TimeDuration} _retryDelay
 * @returns {Promise<string>} Task name
 * @deprecated Use declarative scheduler's initialize() function instead
 */
async function schedule(_capabilities, _name, _cronExpression, _callback, _retryDelay) {
    throw new Error("Legacy scheduler API is deprecated. Use declarative scheduler's initialize() function instead.");
}

module.exports = {
    schedule,
};

