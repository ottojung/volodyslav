/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

/** Default polling interval in milliseconds (10 minutes) */
let POLL_INTERVAL_MS = 600000;

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
            }, module.exports.POLL_INTERVAL_MS);
            
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
    POLL_INTERVAL_MS,
};