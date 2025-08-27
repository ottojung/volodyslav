// @ts-check
/**
 * Compatibility module for daily tasks.
 */

/**
 * Check if daily tasks are unavailable.
 * @param {any} error
 * @returns {boolean}
 */
function isDailyTasksUnavailable(error) {
    return error && error.name === 'DailyTasksUnavailable';
}

/**
 * Daily tasks unavailable error.
 */
class DailyTasksUnavailable extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'DailyTasksUnavailable';
    }
}

module.exports = {
    isDailyTasksUnavailable,
    DailyTasksUnavailable,
};