// @ts-check

/**
 * Serialize TimeDuration to JSON.
 * @param {import('./index').TimeDuration} duration
 * @returns {object}
 */
function toJSON(duration) {
    return { ms: duration.ms };
}

/**
 * Deserialize TimeDuration from JSON.
 * @param {any} json
 * @returns {import('./index').TimeDuration}
 */
function fromJSON(json) {
    const { fromMs } = require('./index');
    
    if (typeof json === 'number') {
        // Support plain number format for backward compatibility
        return fromMs(json);
    }
    
    if (typeof json === 'object' && json !== null && typeof json.ms === 'number') {
        return fromMs(json.ms);
    }
    
    throw new Error(`Invalid TimeDuration JSON format: ${JSON.stringify(json)}`);
}

module.exports = {
    toJSON,
    fromJSON,
};