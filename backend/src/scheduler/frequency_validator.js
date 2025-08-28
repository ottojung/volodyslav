/**
 * Frequency validation for cron expressions.
 * Ensures tasks don't run more frequently than the polling interval can handle.
 */

const { getNextExecution } = require("./expression");

/**
 * Error thrown when task frequency is higher than polling frequency.
 */
class ScheduleFrequencyError extends Error {
    /**
     * @param {number} taskFrequencyMs
     * @param {number} pollFrequencyMs
     */
    constructor(taskFrequencyMs, pollFrequencyMs) {
        // Format frequency display for better readability
        /** @param {number} ms */
        const formatFrequency = (ms) => {
            if (ms < 60 * 1000) {
                const seconds = Math.floor(ms / 1000);
                return `${seconds} second${seconds !== 1 ? 's' : ''}`;
            } else if (ms % (60 * 1000) === 0) {
                // Exact minutes
                const minutes = Math.floor(ms / (60 * 1000));
                return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
            } else {
                // Mixed minutes and seconds
                const totalSeconds = Math.floor(ms / 1000);
                return `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`;
            }
        };

        const taskFreq = formatFrequency(taskFrequencyMs);
        const pollFreq = formatFrequency(pollFrequencyMs);

        super(
            `Task frequency (${taskFreq}) is higher than ` +
            `polling frequency (${pollFreq}). ` +
            `Tasks cannot execute more frequently than the polling interval.`
        );
        this.name = "ScheduleFrequencyError";
        this.taskFrequencyMs = taskFrequencyMs;
        this.pollFrequencyMs = pollFrequencyMs;
    }
}

/**
 * Generate test base times for comprehensive cron interval analysis.
 * @param {import('../datetime').Datetime} dt
 * @returns {Date[]} Array of base times to test from
 */
function generateTestBaseTimes(dt) {
    const now = dt.now();
    const baseTime = dt.toNativeDate(now);
    
    return [
        baseTime,
        new Date(baseTime.getTime() + 60 * 1000), // +1 minute
        new Date(baseTime.getTime() + 60 * 60 * 1000), // +1 hour
        new Date(baseTime.getTime() + 24 * 60 * 60 * 1000), // +1 day
    ];
}

/**
 * Find minimum interval from a specific base time.
 * @param {import('./expression').CronExpression} parsedCron
 * @param {Date} baseTime
 * @param {import('../datetime').Datetime} dt
 * @param {number} targetSamples - Number of consecutive executions to analyze
 * @returns {number} Minimum interval in milliseconds, or Number.MAX_SAFE_INTEGER if no pattern found
 */
function findMinimumIntervalFromBase(parsedCron, baseTime, dt, targetSamples) {
    const baseDt = dt.fromEpochMs(baseTime.getTime());
    let minInterval = Number.MAX_SAFE_INTEGER;

    // Get first execution from this base
    let previousExecution = getNextExecution(parsedCron, baseDt);
    if (!previousExecution) return minInterval;

    // Check consecutive executions to find true minimum interval
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
 * @param {import('./expression').CronExpression} parsedCron
 * @param {import('../datetime').Datetime} dt
 * @returns {number} Minimum interval in milliseconds
 */
function calculateMinimumCronInterval(parsedCron, dt) {
    try {
        const testBases = generateTestBaseTimes(dt);
        let minInterval = Number.MAX_SAFE_INTEGER;
        const targetSamples = 10; // Analyze multiple consecutive executions

        for (const baseTime of testBases) {
            const intervalFromBase = findMinimumIntervalFromBase(parsedCron, baseTime, dt, targetSamples);
            
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
 * Validate that task frequency is not higher than polling frequency
 * @param {import('./expression').CronExpression} parsedCron
 * @param {number} pollIntervalMs
 * @param {import('../datetime').Datetime} dt
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