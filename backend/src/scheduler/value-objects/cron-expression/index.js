// @ts-check
/**
 * @typedef {CronExpressionClass} CronExpression
 */

// Import class from separate file to avoid circular dependencies
const { CronExpressionClass } = require('./class');

/**
 * Create a CronExpression from a cron string.
 * @param {string} str - Cron expression string
 * @returns {CronExpression}
 */
function fromString(str) {
    const { parseExpression } = require('./parse');
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