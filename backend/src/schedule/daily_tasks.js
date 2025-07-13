/**
 * Daily tasks executable wrapper with custom error handling.
 */

const { isCommandUnavailable } = require("../subprocess");
const { volodyslavDailyTasks } = require("../executables");

/**
 * Custom error class for daily tasks executable.
 */
class DailyTasksUnavailable extends Error {
    constructor() {
        super(
            "Daily tasks executable unavailable. volodyslav-daily-tasks executable not found in $PATH. Please ensure that volodyslav-daily-tasks is installed and available in your $PATH, or create an empty executable to skip daily tasks."
        );
        this.name = "DailyTasksUnavailable";
    }
}

/**
 * @param {unknown} object
 * @returns {object is DailyTasksUnavailable}
 */
function isDailyTasksUnavailable(object) {
    return object instanceof DailyTasksUnavailable;
}

/**
 * Ensures that the volodyslav-daily-tasks executable exists in the PATH.
 * @returns {Promise<void>}
 * @throws {DailyTasksUnavailable} - If the executable is not available.
 */
async function ensureDailyTasksAvailable() {
    try {
        await volodyslavDailyTasks.ensureAvailable();
    } catch (error) {
        if (isCommandUnavailable(error)) {
            throw new DailyTasksUnavailable();
        }
        throw error;
    }
}

/**
 * Executes the daily tasks program.
 * @param {import('../capabilities/root').Capabilities} capabilities - The capabilities object.
 * @returns {Promise<void>}
 * @throws {DailyTasksUnavailable} - If the executable is not available.
 */
async function executeDailyTasks(capabilities) {
    try {
        await ensureDailyTasksAvailable();
        const result = await volodyslavDailyTasks.call();

        if (result.stdout) {
            const output = result.stdout.trim();
            const lineCount = output.split("\n").length;
            capabilities.logger.logInfo({ output, lineCount }, `Daily tasks produced ${lineCount} lines of output.`);
        }

        if (result.stderr) {
            const output = result.stderr.trim();
            const lineCount = output.split("\n").length;
            capabilities.logger.logWarning({ output, lineCount }, `Daily tasks produced ${lineCount} lines of stderr.`);
        }

        capabilities.logger.logInfo({}, "Daily tasks completed successfully");
    } catch (error) {
        if (isDailyTasksUnavailable(error)) {
            capabilities.logger.logWarning({}, "Daily tasks executable not found - skipping daily tasks");
        } else {
            capabilities.logger.logError({ error }, "Error executing daily tasks");
            throw error;
        }
    }
}

module.exports = {
    executeDailyTasks,
    ensureDailyTasksAvailable,
    isDailyTasksUnavailable,
    DailyTasksUnavailable,
};
