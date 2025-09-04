/**
 * Previous fire time calculation API wrapper for mathematical algorithm.
 * Maintains API compatibility with existing code.
 */

const { calculatePreviousExecution } = require("./previous_mathematical");

/**
 * Finds the most recent time a cron expression would have fired before the given reference time.
 * 
 * @param {import('../expression').CronExpression} parsedCron - The parsed cron expression
 * @param {import('../../datetime').DateTime} now - The reference point (current time)
 * @returns {{previousFire: import('../../datetime').DateTime|undefined, newCacheTime: import('../../datetime').DateTime|undefined}}
 */
function findPreviousFire(parsedCron, now) {
    try {
        // Use the new mathematical algorithm
        const previousFire = calculatePreviousExecution(parsedCron, now);
        
        return {
            previousFire: previousFire || undefined,
            newCacheTime: previousFire || undefined  // Cache the actual fire time, not evaluation time
        };
    } catch (error) {
        // Return undefined for any calculation errors
        return {
            previousFire: undefined,
            newCacheTime: undefined
        };
    }
}

/**
 * Get the most recent execution time for a cron expression.
 * @param {import('../expression').CronExpression} parsedCron
 * @param {import('../../datetime').DateTime} now
 * @param {import('../../datetime').DateTime|undefined} _lastEvaluatedFire - Unused in mathematical implementation
 * @returns {{lastScheduledFire: import('../../datetime').DateTime|undefined, newLastEvaluatedFire: import('../../datetime').DateTime|undefined}}
 */
function getMostRecentExecution(parsedCron, now, _lastEvaluatedFire) {
    const { previousFire, newCacheTime } = findPreviousFire(parsedCron, now);
    return {
        lastScheduledFire: previousFire,
        newLastEvaluatedFire: newCacheTime
    };
}

module.exports = {
    getMostRecentExecution,
};
