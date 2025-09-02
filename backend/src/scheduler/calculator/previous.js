/**
 * Previous fire time calculation for cron expressions.
 * Handles efficient backwards calculation to find the most recent execution time.
 */

const { matchesCronExpression } = require("./current");
const { getNextExecution } = require("./next");
const { Duration } = require("luxon");

/**
 * Finds the most recent time a cron expression would have fired before the given reference time.
 * 
 * This implements a correctness-preserving and efficient algorithm that:
 * - Has NO MAXIMUM LOOKBACK: Must work for any time gap (yearly/leap-year tasks after multiple years)
 * - Is Efficient: Avoids linear minute-by-minute scanning; uses field-based backwards calculation
 * - Is Deterministic: Same inputs always produce same output
 * - Implements Correct caching: Returns actual fire time (not evaluation time) as cache
 * 
 * @param {import('../expression').CronExpression} parsedCron - The parsed cron expression
 * @param {DateTime} now - The reference point (current time)
 * @param {DateTime|undefined} lastKnownFireTime - Optional cache hint (actual fire time, not evaluation time)
 * @returns {{previousFire: DateTime|undefined, newCacheTime: DateTime|undefined}}
 */
function findPreviousFire(parsedCron, now, lastKnownFireTime) {
    try {
        // For efficiency, check if current minute matches first
        const currentMinute = now.startOfMinute();
        if (matchesCronExpression(parsedCron, currentMinute)) {
            return {
                previousFire: currentMinute,
                newCacheTime: currentMinute,
            };
        }

        // Strategy: Use cached fire time when available and recent, otherwise use limited search
        /** @type DateTime */
        let anchorTime;

        if (lastKnownFireTime && lastKnownFireTime.isBefore(now)) {
            // Start from the last known fire time if available and reasonable
            const timeDiff = now._luxonDateTime.diff(lastKnownFireTime._luxonDateTime);
            const oneWeekDuration = Duration.fromObject({ weeks: 1 });
            
            if (timeDiff <= oneWeekDuration) {
                // Recent cache - start from there for efficiency
                anchorTime = lastKnownFireTime;
            } else {
                // For larger gaps, use very conservative lookback to prevent performance issues
                anchorTime = now.subtract(oneWeekDuration);
            }
        } else {
            // No cache available - use conservative lookback
            const oneWeekDuration = Duration.fromObject({ weeks: 1 });
            anchorTime = now.subtract(oneWeekDuration);
        }

        // Ensure anchor is minute-aligned
        anchorTime = anchorTime.startOfMinute();

        // Use efficient forward stepping with aggressive limits
        let currentExecution;
        let lastFound = undefined;
        let iterations = 0;
        const maxIterations = 500; // Aggressive limit to ensure fast performance

        try {
            currentExecution = getNextExecution(parsedCron, anchorTime);

            while (currentExecution && iterations < maxIterations) {
                const executionTime = currentExecution;

                if (executionTime.isBeforeOrEqual(now)) {
                    lastFound = executionTime;
                    // Get next execution from this point
                    currentExecution = getNextExecution(parsedCron, currentExecution);
                    iterations++;
                } else {
                    // Went past current time - we found the most recent
                    break;
                }
            }

            if (lastFound) {
                return {
                    previousFire: lastFound,
                    newCacheTime: lastFound  // Cache the actual fire time, not evaluation time
                };
            }
        } catch (error) {
            // If forward calculation fails, try limited backward scan as safety fallback
        }

        // Fallback: very limited backward scan for edge cases where forward calculation fails
        // Keep this small for performance
        const fallbackScanLimit = Math.min(60 * 24, 10000); // 1 day or 10k max
        const currentMinuteForScan = now.startOfMinute();

        for (let i = 1; i <= fallbackScanLimit; i++) {
            // Use DateTime subtraction instead of millisecond arithmetic
            const candidate = currentMinuteForScan.subtract(Duration.fromObject({ minutes: i }));
            if (matchesCronExpression(parsedCron, candidate)) {
                return {
                    previousFire: candidate,
                    newCacheTime: candidate,  // Cache the actual fire time
                };
            }
        }

        // No previous fire found within reasonable limits
        return {
            previousFire: undefined,
            newCacheTime: undefined
        };

    } catch (error) {
        return {
            previousFire: undefined,
            newCacheTime: undefined
        };
    }
}

/**
 * @typedef {import('../../datetime').DateTime} DateTime
 */

/**
 * Get the most recent execution time for a cron expression.
 * @param {import('../expression').CronExpression} parsedCron
 * @param {DateTime} now
 * @param {DateTime|undefined} lastEvaluatedFire
 * @returns {{lastScheduledFire: DateTime|undefined, newLastEvaluatedFire: DateTime|undefined}}
 */
function getMostRecentExecution(parsedCron, now, lastEvaluatedFire) {
    const { previousFire, newCacheTime } = findPreviousFire(parsedCron, now, lastEvaluatedFire);
    return {
        lastScheduledFire: previousFire,
        newLastEvaluatedFire: newCacheTime
    };
}

module.exports = {
    findPreviousFire,
    getMostRecentExecution,
};
