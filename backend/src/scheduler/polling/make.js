/**
 * Polling based cron scheduler.
 */

const { mutateTasks } = require("../persistence");
const { makeTaskExecutor } = require("../execution");
const { makePollingFunction } = require("./function");

/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../datetime').Duration} Duration
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../types').Callback} Callback
 */

/** @typedef {import('../types').Registration} Registration */

/**
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 */

/**
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {string} schedulerIdentifier
 */
function makePollingScheduler(capabilities, registrations, schedulerIdentifier) {
    /** @type {Set<string>} */
    const scheduledTasks = new Set(); // Task names that are enabled. Is a subset of names in `registrations`.

    // Create task executor for handling task execution
    const taskExecutor = makeTaskExecutor(capabilities, (transformation) => mutateTasks(capabilities, registrations, transformation));

    // Create polling function with lifecycle management
    const intervalManager = makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor, schedulerIdentifier);

    function start() {
        intervalManager.start();
    }

    async function stop() {
        await intervalManager.stop();
    }

    return {
        /**
         * Schedule a new task.
         * @param {string} name
         * @returns {void}
         */
        schedule(name) {
            const found = registrations.get(name);
            if (found === undefined) {
                throw new Error(`Impossible: registration ${JSON.stringify(name)} not found`);
            }

            if (scheduledTasks.size === 0) {
                start();
            }

            scheduledTasks.add(name);
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {boolean} True if the task was found and cancelled, false otherwise.
         */
        cancel(name) {
            const existed = scheduledTasks.delete(name);
            if (scheduledTasks.size === 0) {
                stop();
            }
            return existed;
        },

        async stopLoop() {
            return await stop();
        },

        /**
         * Cancel all tasks and stop polling.
         * @returns {number} The number of tasks that were cancelled.
         */
        cancelAll() {
            const count = scheduledTasks.size;
            scheduledTasks.clear();
            stop();
            return count;
        },
    };
}

module.exports = {
    makePollingScheduler,
};
