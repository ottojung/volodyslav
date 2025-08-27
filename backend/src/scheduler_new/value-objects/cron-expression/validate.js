// @ts-check

/**
 * Validate cron expressions.
 */

/**
 * Validate a cron expression string without parsing.
 * @param {string} cronStr - Cron expression to validate
 * @returns {boolean} True if valid
 */
function isValid(cronStr) {
    try {
        const { parseExpression } = require('./parse');
        parseExpression(cronStr);
        return true;
    } catch {
        return false;
    }
}

/**
 * Validate cron expression syntax and semantics.
 * @param {string} cronStr - Cron expression to validate
 * @throws {Error} If invalid
 */
function validateExpression(cronStr) {
    const { parseExpression } = require('./parse');
    
    // This will throw if invalid
    const cron = parseExpression(cronStr);
    
    // Additional semantic validations can go here
    // For now, the parsing validation is sufficient
    
    return cron;
}

module.exports = {
    isValid,
    validateExpression,
};