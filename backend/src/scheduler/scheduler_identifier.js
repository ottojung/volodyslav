/**
 * Scheduler identifier generation for tracking task ownership.
 * Each scheduler instance gets a unique identifier to detect
 * orphaned tasks from previous shutdowns.
 */

const { string } = require('../random');

/** @typedef {import('./types').SchedulerCapabilities} SchedulerCapabilities */

/**
 * Generates a unique identifier for this scheduler instance.
 * @param {SchedulerCapabilities} capabilities
 * @returns {string}
 */
function generateSchedulerIdentifier(capabilities) {
    return string(capabilities, 8);
}

module.exports = {
    generateSchedulerIdentifier,
};