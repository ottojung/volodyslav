/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

const { getPollIntervalMs } = require('./delay');

/**
 * Create an interval manager for handling polling timing.
 * @param {() => Promise<void>} pollFunction - Function to call on each poll
 * @param {import('../../capabilities/root').Capabilities} capabilities - For error logging
 * @returns {{start: () => void, stop: () => void}} Interval manager with start/stop methods
 */
function makeIntervalManager(pollFunction, capabilities) {
    /** @type {NodeJS.Timeout | null} */
    let interval = null;

    function start() {
        if (interval === null) {
            interval = setInterval(async () => {
                try {
                    await pollFunction();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logError({ errorMessage: message }, `Unexpected poll error: ${message}`);
                }
            }, getPollIntervalMs());

            // Allow Node.js to exit gracefully if this is the only remaining timer
            interval.unref();
        }
    }

    function stop() {
        if (interval !== null) {
            clearInterval(interval);
            interval = null;
        }
    }

    return { start, stop };
}

module.exports = {
    makeIntervalManager,
};
