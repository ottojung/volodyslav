/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

const { fromMilliseconds } = require('../../datetime/duration');

const POLL_INTERVAL_MS = 600000;
const POLL_INTERVAL = fromMilliseconds(POLL_INTERVAL_MS);
const THREAD_NAME = "volodyslav:scheduler:poll"

/**
 * Create an interval manager for handling polling timing.
 * @param {() => Promise<void>} pollFunction - Function to call on each poll
 * @param {import('../../capabilities/root').Capabilities} capabilities - For error logging
 * @returns {{start: () => void, stop: () => Promise<void>}} Interval manager with start/stop methods
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

    const thread = capabilities.threading.periodic(THREAD_NAME, POLL_INTERVAL, wrappedPoll);
    const start = () => thread.start();
    const stop = async () => await thread.stop();

    return { start, stop };
}

module.exports = {
    makeIntervalManager,
    POLL_INTERVAL_MS,
    POLL_INTERVAL,
    THREAD_NAME,
};
