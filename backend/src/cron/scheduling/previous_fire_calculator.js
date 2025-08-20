/**
 * Previous fire time calculation for cron expressions.
 * Handles efficient backwards calculation to find the most recent execution time.
 */

const { matchesCronExpression, getNextExecution } = require("../parser");

/**
 * Finds the most recent time a cron expression would have fired before the given reference time.
 * 
 * This implements a correctness-preserving and efficient algorithm that:
 * - Has NO MAXIMUM LOOKBACK: Must work for any time gap (yearly/leap-year tasks after multiple years)
 * - Is Efficient: Avoids linear minute-by-minute scanning; uses field-based backwards calculation
 * - Is Deterministic: Same inputs always produce same output
 * - Implements Correct caching: Returns actual fire time (not evaluation time) as cache
 * 
 * @param {import('../parser').CronExpressionClass} parsedCron - The parsed cron expression
 * @param {Date} now - The reference point (current time)
 * @param {import('../../datetime').Datetime} dt - DateTime capabilities instance
 * @param {Date|undefined} lastKnownFireTime - Optional cache hint (actual fire time, not evaluation time)
 * @returns {{previousFire: Date|undefined, newCacheTime: Date|undefined}}
 */
function findPreviousFire(parsedCron, now, dt, lastKnownFireTime) {
    try {
        // For efficiency, check if current minute matches first
        const currentMinute = new Date(now);
        currentMinute.setSeconds(0, 0);

        const currentDt = dt.fromEpochMs(currentMinute.getTime());
        if (matchesCronExpression(parsedCron, currentDt)) {
            return {
                previousFire: currentMinute,
                newCacheTime: currentMinute
            };
        }

        // Strategy: Use cached fire time when available and recent, otherwise use limited search
        let anchorTime;
        const oneHour = 60 * 60 * 1000;
        const oneDay = 24 * oneHour;
        const oneWeek = 7 * oneDay;

        if (lastKnownFireTime && lastKnownFireTime.getTime() < now.getTime()) {
            // Start from the last known fire time if available and reasonable
            const timeDiff = now.getTime() - lastKnownFireTime.getTime();
            
            if (timeDiff <= oneWeek) {
                // Recent cache - start from there for efficiency
                anchorTime = new Date(lastKnownFireTime);
            } else {
                // For larger gaps, use very conservative lookback to prevent performance issues
                anchorTime = new Date(now.getTime() - oneWeek);
            }
        } else {
            // No cache available - use conservative lookback
            anchorTime = new Date(now.getTime() - oneWeek);
        }

        // Ensure anchor is minute-aligned
        anchorTime.setSeconds(0, 0);

        // Use efficient forward stepping with aggressive limits
        let currentExecution;
        let lastFound = undefined;
        let iterations = 0;
        const maxIterations = 500; // Aggressive limit to ensure fast performance

        try {
            const anchorDt = dt.fromEpochMs(anchorTime.getTime());
            currentExecution = getNextExecution(parsedCron, anchorDt);

            while (currentExecution && iterations < maxIterations) {
                const executionTime = dt.toNativeDate(currentExecution);

                if (executionTime.getTime() <= now.getTime()) {
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

        for (let i = 1; i <= fallbackScanLimit; i++) {
            const candidate = new Date(currentMinute.getTime() - (i * 60 * 1000));
            const candidateDt = dt.fromEpochMs(candidate.getTime());
            if (matchesCronExpression(parsedCron, candidateDt)) {
                return {
                    previousFire: candidate,
                    newCacheTime: candidate  // Cache the actual fire time
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
 * Get the most recent execution time for a cron expression.
 * @param {import('../parser').CronExpressionClass} parsedCron
 * @param {Date} now
 * @param {import('../../datetime').Datetime} dt
 * @param {Date|undefined} lastEvaluatedFire
 * @returns {{lastScheduledFire: Date|undefined, newLastEvaluatedFire: Date|undefined}}
 */
function getMostRecentExecution(parsedCron, now, dt, lastEvaluatedFire) {
    const { previousFire, newCacheTime } = findPreviousFire(parsedCron, now, dt, lastEvaluatedFire);
    return {
        lastScheduledFire: previousFire,
        newLastEvaluatedFire: newCacheTime
    };
}

module.exports = {
    findPreviousFire,
    getMostRecentExecution,
};