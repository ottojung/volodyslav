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

/**
 * Ensure daily tasks executable is available.
 * @returns {Promise<void>}
 * @throws {DailyTasksUnavailable} If daily tasks are not available
 */
async function ensureDailyTasksAvailable() {
    // For now, this is a stub that always throws since volodyslavDailyTasks is not implemented
    throw new DailyTasksUnavailable("Daily tasks executable is not available");
}

/**
 * Execute daily tasks.
 * @param {any} capabilities
 * @returns {Promise<void>}
 */
async function executeDailyTasks(capabilities) {
    try {
        await ensureDailyTasksAvailable();
        capabilities.logger.logInfo({}, "Daily tasks executed successfully");
    } catch (error) {
        if (isDailyTasksUnavailable(error)) {
            capabilities.logger.logWarning({}, "Daily tasks unavailable, skipping");
        } else {
            capabilities.logger.logError({ error }, "Error executing daily tasks");
            throw error;
        }
    }
}

module.exports = {
    isDailyTasksUnavailable,
    DailyTasksUnavailable,
    ensureDailyTasksAvailable,
    executeDailyTasks,
};