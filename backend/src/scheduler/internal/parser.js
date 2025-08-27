// @ts-check
/**
 * Compatibility module for cron parser functions.
 */

// Compatibility imports - not currently used in stub implementations
// const { fromString, isCronExpression } = require('../value-objects/cron-expression');

/**
 * Check if a cron expression matches a specific time.
 * @param {any} _cronExpr
 * @param {any} _dateTime
 * @returns {boolean}
 */
function matchesCronExpression(_cronExpr, _dateTime) {
    // This is a compatibility function - for now just return false
    // The new implementation uses a different approach
    return false;
}

module.exports = {
    matchesCronExpression,
};