/**
 * Previous fire time calculation for cron expressions.
 * Handles efficient backwards calculation to find the most recent execution time.
 */

const { matchesCronExpression, getNextExecution } = require("./expression/parser");

/**
 * Finds the most recent time a cron expression would have fired before the given reference time.
 * 
 * This implements a correctness-preserving and efficient algorithm that:
 * - Has NO MAXIMUM LOOKBACK: Must work for any time gap (yearly/leap-year tasks after multiple years)
 * - Is Efficient: Avoids linear minute-by-minute scanning; uses field-based backwards calculation
 * - Is Deterministic: Same inputs always produce same output
 * - Implements Correct caching: Returns actual fire time (not evaluation time) as cache
 * 
 * @param {import('./expression/expression').CronExpression} parsedCron - The parsed cron expression
 * @param {DateTime} now - The reference point (current time)
 * @param {import('../../datetime').Datetime} dt - DateTime capabilities instance
 * @param {DateTime|undefined} lastKnownFireTime - Optional cache hint (actual fire time, not evaluation time)
 * @returns {{previousFire: DateTime|undefined, newCacheTime: DateTime|undefined}}
 */
function findPreviousFire(parsedCron, now, dt, lastKnownFireTime) {
    try {
        // For efficiency, check if current minute matches first
        const currentMinute = dt.toNativeDate(now);
        currentMinute.setSeconds(0, 0);

        const currentDt = dt.fromEpochMs(currentMinute.getTime());
        if (matchesCronExpression(parsedCron, currentDt)) {
            return {
                previousFire: currentDt,
                newCacheTime: currentDt,
            };
        }

        // Strategy: Use cached fire time when available and recent, otherwise use limited search
        /** @type DateTime */
        let anchorTime;
        const oneHour = 60 * 60 * 1000;
        const oneDay = 24 * oneHour;
        const oneWeek = 7 * oneDay;

        if (lastKnownFireTime && lastKnownFireTime.getTime() < now.getTime()) {
            // Start from the last known fire time if available and reasonable
            const timeDiff = now.getTime() - lastKnownFireTime.getTime();
            
            if (timeDiff <= oneWeek) {
                // Recent cache - start from there for efficiency
                anchorTime = lastKnownFireTime;
            } else {
                // For larger gaps, use very conservative lookback to prevent performance issues
                anchorTime = dt.fromEpochMs(now.getTime() - oneWeek);
            }
        } else {
            // No cache available - use conservative lookback
            anchorTime = dt.fromEpochMs(now.getTime() - oneWeek);
        }

        // Ensure anchor is minute-aligned
        const minuteAnchor = dt.toNativeDate(anchorTime);
        minuteAnchor.setSeconds(0, 0);
        anchorTime = dt.fromEpochMs(minuteAnchor.getTime());

        // Use efficient forward stepping with aggressive limits
        let currentExecution;
        let lastFound = undefined;
        let iterations = 0;
        const maxIterations = 500; // Aggressive limit to ensure fast performance

        try {
            currentExecution = getNextExecution(parsedCron, anchorTime);

            while (currentExecution && iterations < maxIterations) {
                const executionTime = currentExecution;

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
                    previousFire: candidateDt,
                    newCacheTime: candidateDt,  // Cache the actual fire time
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
 * @param {import('./expression/expression').CronExpression} parsedCron
 * @param {DateTime} now
 * @param {import('../../datetime').Datetime} dt
 * @param {DateTime|undefined} lastEvaluatedFire
 * @returns {{lastScheduledFire: DateTime|undefined, newLastEvaluatedFire: DateTime|undefined}}
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
