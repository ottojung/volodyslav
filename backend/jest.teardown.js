/**
 * Jest teardown for backend tests.
 * Ensures all scheduler threads are properly cleaned up to prevent worker process issues.
 */

const { cleanupAllSchedulerThreads } = require('./tests/stubs');

module.exports = async () => {
    // Clean up any remaining scheduler threads
    cleanupAllSchedulerThreads();
};