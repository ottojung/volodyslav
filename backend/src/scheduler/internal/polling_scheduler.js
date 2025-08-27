// @ts-check
/**
 * Compatibility module for polling scheduler constants.
 */

const { DEFAULT_POLL_INTERVAL_MS } = require('../constants');

// Export the poll interval for test compatibility
module.exports = {
    POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS,
};