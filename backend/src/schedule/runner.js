/**
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {string} name
 * @param {string} cronExpression
 * @param {() => Promise<void>} callback
 * @param {import('../time_duration/structure').TimeDuration} retryDelay
 * @returns {Promise<string>} Task name
 */
async function schedule(capabilities, name, cronExpression, callback, retryDelay) {
    await capabilities.scheduler.schedule(name, cronExpression, callback, retryDelay);
    return name;
}

module.exports = {
    schedule,
};

