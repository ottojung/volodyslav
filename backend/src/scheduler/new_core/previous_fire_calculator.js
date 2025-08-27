/**
 * Previous fire time calculation for cron expressions.
 * Handles efficient backwards calculation to find the most recent execution time.
 */

const { matchesCronExpression } = require('../new_cron/parser');

/** @typedef {import('../../datetime').DateTime} DateTime */
/** @typedef {import('../new_types/task_types').CronExpression} CronExpression */

/**
 * Finds the most recent time a cron expression would have fired before the given reference time.
 * 
 * @param {CronExpression} parsedCron - The parsed cron expression
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
        if (matchesCronExpression(parsedCron, dt.toNativeDate(currentDt))) {
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
                // Old cache - start from a week ago
                anchorTime = dt.fromEpochMs(now.getTime() - oneWeek);
            }
        } else {
            // No cache - start from a week ago for reasonable performance
            anchorTime = dt.fromEpochMs(now.getTime() - oneWeek);
        }

        // Search backwards from now to the anchor time
        let current = dt.fromEpochMs(currentMinute.getTime() - 60000); // Start one minute back
        const stopTime = anchorTime.getTime();
        const maxIterations = 7 * 24 * 60; // One week worth of minutes
        let iterations = 0;

        while (current.getTime() >= stopTime && iterations < maxIterations) {
            if (matchesCronExpression(parsedCron, dt.toNativeDate(current))) {
                return {
                    previousFire: current,
                    newCacheTime: current,
                };
            }

            // Go back one minute
            current = dt.fromEpochMs(current.getTime() - 60000);
            iterations++;
        }

        // If we didn't find a match in the recent past, there might not be one
        return {
            previousFire: undefined,
            newCacheTime: currentDt, // Cache current time for next search
        };

    } catch (error) {
        // If calculation fails, return undefined but cache current time
        return {
            previousFire: undefined,
            newCacheTime: dt.fromEpochMs(now.getTime()),
        };
    }
}

/**
 * Get the most recent execution time for a cron expression.
 * @param {CronExpression} parsedCron
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