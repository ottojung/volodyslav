// @ts-check
/**
 * @typedef {CronExpressionClass} CronExpression
 */

// Import class from separate file to avoid circular dependencies
const { CronExpressionClass } = require('./class');
// Import parse function at module level to avoid Jest teardown issues
const { parseExpression } = require('./parse');

/**
 * Create a CronExpression from a cron string.
 * @param {string} str - Cron expression string
 * @returns {CronExpression}
 */
function fromString(str) {
    return parseExpression(str);
}

/**
 * Type guard for CronExpression.
 * @param {any} object
 * @returns {object is CronExpression}
 */
function isCronExpression(object) {
    return object instanceof CronExpressionClass;
}

module.exports = {
    fromString,
    isCronExpression,
    CronExpressionClass, // Export class for internal use
};