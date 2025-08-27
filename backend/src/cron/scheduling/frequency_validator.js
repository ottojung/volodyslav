/**
 * Frequency validation for cron expressions.
 * Ensures tasks don't run more frequently than the polling interval can handle.
 */

const { getNextExecution } = require("../parser");
const { ScheduleFrequencyError } = require("../polling_scheduler_errors");

/**
 * Calculate the minimum interval between executions for a cron expression.
 * @param {import('../expression').CronExpression} parsedCron
 * @param {import('../../datetime').Datetime} dt
 * @returns {number} Minimum interval in milliseconds
 */
function calculateMinimumCronInterval(parsedCron, dt) {
    try {
        // Use multiple test time bases to capture different scenarios
        const now = dt.now();
        const baseTime = dt.toNativeDate(now);
        
        // Test from multiple starting points to find true minimum
        const testBases = [
            baseTime,
            new Date(baseTime.getTime() + 60 * 1000), // +1 minute
            new Date(baseTime.getTime() + 60 * 60 * 1000), // +1 hour
            new Date(baseTime.getTime() + 24 * 60 * 60 * 1000), // +1 day
        ];

        let minInterval = Number.MAX_SAFE_INTEGER;
        const targetSamples = 10; // Analyze multiple consecutive executions

        for (const baseTime of testBases) {
            const baseDt = dt.fromEpochMs(baseTime.getTime());

            // Get first execution from this base
            let previousExecution = getNextExecution(parsedCron, baseDt);
            if (!previousExecution) continue;

            // Check more consecutive executions to find true minimum interval
            for (let i = 0; i < targetSamples; i++) {
                const nextExecution = getNextExecution(parsedCron, previousExecution);
                if (!nextExecution) break;

                const prevMs = dt.toNativeDate(previousExecution).getTime();
                const nextMs = dt.toNativeDate(nextExecution).getTime();
                const interval = nextMs - prevMs;

                if (interval > 0 && interval < minInterval) {
                    minInterval = interval;
                }

                previousExecution = nextExecution;

                // Early termination for very frequent expressions
                if (minInterval < 60 * 1000) {
                    return minInterval; // Found sub-minute frequency
                }
            }
        }

        // Handle edge cases
        if (minInterval === Number.MAX_SAFE_INTEGER) {
            // No executions found - expression might be invalid or very infrequent
            return 365 * 24 * 60 * 60 * 1000; // 1 year (conservative safe default)
        }

        if (minInterval > 365 * 24 * 60 * 60 * 1000) {
            // Expression executes less than yearly - safe to allow
            return minInterval;
        }

        return minInterval;

    } catch (error) {
        // If calculation fails, be conservative
        return 365 * 24 * 60 * 60 * 1000; // 1 year (very safe default)
    }
}

/**
 * Validate that task frequency is not higher than polling frequency
 * @param {import('../expression').CronExpression} parsedCron
 * @param {number} pollIntervalMs
 * @param {import('../../datetime').Datetime} dt
 * @throws {ScheduleFrequencyError}
 */
function validateTaskFrequency(parsedCron, pollIntervalMs, dt) {
    const minCronInterval = calculateMinimumCronInterval(parsedCron, dt);

    if (minCronInterval < pollIntervalMs) {
        throw new ScheduleFrequencyError(minCronInterval, pollIntervalMs);
    }
}

module.exports = {
    calculateMinimumCronInterval,
    validateTaskFrequency,
};