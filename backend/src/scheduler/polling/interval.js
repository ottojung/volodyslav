/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

const POLL_INTERVAL_MS = 600000;

/**
 * Create an interval manager for handling polling timing.
 * @param {() => Promise<void>} pollFunction - Function to call on each poll
 * @param {import('../../capabilities/root').Capabilities} capabilities - For error logging
 * @returns {{start: () => void, stop: () => void}} Interval manager with start/stop methods
 */
function makeIntervalManager(pollFunction, capabilities) {
    async function wrappedPoll() {
        try {
            await pollFunction();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            capabilities.logger.logError({ errorMessage: message }, `Unexpected poll error: ${message}`);
        }
    }

    const thread = capabilities.threading.periodic("scheduler:poll", POLL_INTERVAL_MS, wrappedPoll);
    const start = thread.start;    
    const stop = thread.stop;

    return { start, stop };
}

module.exports = {
    makeIntervalManager,
    POLL_INTERVAL_MS,
};
