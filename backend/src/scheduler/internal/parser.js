// @ts-check
/**
 * Compatibility module for cron parser functions.
 */

const { fromString, isCronExpression } = require('../value-objects/cron-expression');

/**
 * Check if a cron expression matches a specific time.
 * @param {any} cronExpr
 * @param {any} dateTime
 * @returns {boolean}
 */
function matchesCronExpression(cronExpr, dateTime) {
    // This is a compatibility function - for now just return false
    // The new implementation uses a different approach
    return false;
}

module.exports = {
    matchesCronExpression,
};