/**
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {string} name
 * @param {string} cronExpression
 * @param {() => Promise<void>} callback
 * @param {import('../time_duration/structure').TimeDuration} retryDelay
 * @returns {string} Task name
 */
function schedule(capabilities, name, cronExpression, callback, retryDelay) {
    capabilities.scheduler.schedule(name, cronExpression, callback, retryDelay);
    return name;
}

module.exports = {
    schedule,
};

