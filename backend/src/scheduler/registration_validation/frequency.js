/**
 * Frequency validation for cron expressions.
 * Ensures tasks don't run more frequently than the polling interval can handle.
 */

const { getNextExecution } = require("../calculator");
const { difference, fromISOString } = require("../../datetime");

/**
 * @typedef {import('../../datetime').Duration} Duration
 */

const baseTime = fromISOString("2024-01-01T00:00:00Z");

/**
 * Find minimum interval from a specific base time.
 * @param {import('../expression').CronExpression} parsedCron
 * @returns {Duration} Minimum interval in milliseconds, or Number.MAX_SAFE_INTEGER if no pattern found
 */
function findInterval(parsedCron) {
    const initialExecution = getNextExecution(parsedCron, baseTime);
    const subsequentExecution = getNextExecution(parsedCron, initialExecution);
    return difference(subsequentExecution, initialExecution);
}

/**
 * @typedef {object} Capabilities
 * @property {import('../../logger').Logger} logger
 */

/**
 * Validate that task frequency is not higher than polling frequency
 * @param {Capabilities} capabilities
 * @param {import('../expression').CronExpression} parsedCron
 * @param {Duration} pollInterval
 */
function validateTaskFrequency(capabilities, parsedCron, pollInterval) {
    const aCronInterval = findInterval(parsedCron);

    if (aCronInterval < pollInterval) {
        capabilities.logger.logWarning(
            { aCronInterval, pollInterval, cron: parsedCron.original },
            `Task with cron expression "${parsedCron.original}" has an interval of ` +
            `${aCronInterval}, which is less than the polling interval of ${pollInterval}.`
        );
    }
}

module.exports = {
    validateTaskFrequency,
};
