// @ts-check

/**
 * Parse time duration from human-readable strings.
 * @param {string} str - Human readable duration like "30m", "500ms"
 * @returns {import('./index').TimeDuration}
 */
function parseFromString(str) {
    const { fromMs, fromMinutes } = require('./index');
    
    if (typeof str !== 'string') {
        throw new Error("Duration string must be a string");
    }

    // Match patterns like "30m", "500ms", "1h", etc.
    const match = str.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
    
    if (!match || !match[1] || !match[2]) {
        throw new Error(`Invalid duration format: ${str}`);
    }

    const value = parseFloat(match[1]);
    const unit = match[2];

    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid duration value: ${value}`);
    }

    switch (unit) {
        case 'ms':
            return fromMs(Math.floor(value));
        case 's':
            return fromMs(Math.floor(value * 1000));
        case 'm':
            return fromMinutes(value);
        case 'h':
            return fromMinutes(value * 60);
        default:
            throw new Error(`Unsupported duration unit: ${unit}`);
    }
}

module.exports = {
    parseFromString,
};