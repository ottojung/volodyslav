// @ts-check

/**
 * Serialize and deserialize cron expressions.
 */

/**
 * Deserialize a cron expression from JSON.
 * @param {string} jsonStr - JSON string representation
 * @returns {import('./index').CronExpression}
 */
function fromJSON(jsonStr) {
    const { fromString } = require('./index');
    
    if (typeof jsonStr !== 'string') {
        throw new Error("Cron expression JSON must be a string");
    }
    
    return fromString(jsonStr);
}

/**
 * Serialize a cron expression to JSON.
 * @param {import('./index').CronExpression} cron
 * @returns {string}
 */
function toJSON(cron) {
    return cron.original;
}

module.exports = {
    fromJSON,
    toJSON,
};