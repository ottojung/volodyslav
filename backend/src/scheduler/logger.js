// @ts-check
/**
 * Tiny logging wrapper for the scheduler.
 */

/**
 * Log an event with payload.
 * @param {string} eventName - Event name
 * @param {object} payload - Event payload
 * @param {import('../logger').Logger} logger - Logger instance
 */
function logEvent(eventName, payload, logger) {
    switch (eventName) {
        case 'startup_validated':
        case 'task_dispatched':
        case 'task_started':
        case 'task_succeeded':
        case 'retry_scheduled':
            logger.logInfo(payload, eventName);
            break;
        case 'task_failed':
            logger.logError(payload, eventName);
            break;
        default:
            logger.logDebug(payload, eventName);
            break;
    }
}

module.exports = {
    logEvent,
};