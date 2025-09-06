/**
 * Frequency validation for cron expressions.
 * Ensures tasks don't run more frequently than the polling interval can handle.
 */

const { getNextExecution } = require("../calculator");
const { difference, fromMinutes, fromHours, fromDays } = require("../../datetime");

/**
 * Generate test base times for comprehensive cron interval analysis.
 * @param {import('../../datetime').Datetime} dt
 * @returns {import('../../datetime').DateTime[]} Array of base DateTimes to test from
 */
function generateTestBaseTimes(dt) {
    const now = dt.now();

    return [
        now,
        now.advance(fromMinutes(1)), // +1 minute
        now.advance(fromHours(1)), // +1 hour
        now.advance(fromDays(1)), // +1 day
    ];
}

/**
 * Find minimum interval from a specific base time.
 * @param {import('../expression').CronExpression} parsedCron
 * @param {import('../../datetime').DateTime} baseTime
 * @param {number} targetSamples - Number of consecutive executions to analyze
 * @returns {number} Minimum interval in milliseconds, or Number.MAX_SAFE_INTEGER if no pattern found
 */
function findMinimumIntervalFromBase(parsedCron, baseTime, targetSamples) {
    let minInterval = Number.MAX_SAFE_INTEGER;

    // Get first execution from this base
    let previousExecution = getNextExecution(parsedCron, baseTime);
    if (!previousExecution) return minInterval;

    // Check consecutive executions to find true minimum interval
    for (let i = 0; i < targetSamples; i++) {
        const nextExecution = getNextExecution(parsedCron, previousExecution);
        if (!nextExecution) break;

        const interval = difference(nextExecution, previousExecution).toMillis();

        if (interval > 0 && interval < minInterval) {
            minInterval = interval;
        }

        previousExecution = nextExecution;

        // Early termination for very frequent expressions
        if (minInterval < 60 * 1000) {
            return minInterval; // Found sub-minute frequency
        }
    }

    return minInterval;
}

/**
 * Handle edge cases for minimum interval calculation.
 * @param {number} minInterval - The calculated minimum interval
 * @returns {number} Adjusted minimum interval
 */
function handleEdgeCases(minInterval) {
    // No executions found - expression might be invalid or very infrequent
    if (minInterval === Number.MAX_SAFE_INTEGER) {
        return 365 * 24 * 60 * 60 * 1000; // 1 year (conservative safe default)
    }

    // Expression executes less than yearly - safe to allow
    if (minInterval > 365 * 24 * 60 * 60 * 1000) {
        return minInterval;
    }

    return minInterval;
}

/**
 * Calculate the minimum interval between executions for a cron expression.
 * @param {import('../expression').CronExpression} parsedCron
 * @param {import('../../datetime').Datetime} dt
 * @returns {number} Minimum interval in milliseconds
 */
function calculateMinimumCronInterval(parsedCron, dt) {
    try {
        const testBases = generateTestBaseTimes(dt);
        let minInterval = Number.MAX_SAFE_INTEGER;
        const targetSamples = 10; // Analyze multiple consecutive executions

        for (const baseTime of testBases) {
            const intervalFromBase = findMinimumIntervalFromBase(parsedCron, baseTime, targetSamples);

            if (intervalFromBase < minInterval) {
                minInterval = intervalFromBase;
            }

            // Early termination for very frequent expressions
            if (minInterval < 60 * 1000) {
                return minInterval; // Found sub-minute frequency
            }
        }

        return handleEdgeCases(minInterval);

    } catch (error) {
        // If calculation fails, be conservative
        return 365 * 24 * 60 * 60 * 1000; // 1 year (very safe default)
    }
}

/**
 * @typedef {object} Capabilities
 * @property {import('../../logger').Logger} logger
 */

/**
 * Validate that task frequency is not higher than polling frequency
 * @param {Capabilities} capabilities
 * @param {import('../expression').CronExpression} parsedCron
 * @param {number} pollIntervalMs
 * @param {import('../../datetime').Datetime} dt
 */
function validateTaskFrequency(capabilities, parsedCron, pollIntervalMs, dt) {
    const minCronInterval = calculateMinimumCronInterval(parsedCron, dt);

    if (minCronInterval < pollIntervalMs) {
        capabilities.logger.logWarning(
            { minCronInterval, pollIntervalMs, cron: parsedCron.original },
            `Task with cron expression "${parsedCron.original}" has a minimum interval of ` +
            `${minCronInterval} ms, which is less than the polling interval of ${pollIntervalMs} ms.`
        );
    }
}

module.exports = {
    validateTaskFrequency,
};
