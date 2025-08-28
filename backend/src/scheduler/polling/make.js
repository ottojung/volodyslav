/**
 * Polling based cron scheduler.
 */

const { mutateTasks } = require("../persistence");
const { makeTaskExecutor } = require("../execution");
const { validateTaskFrequency } = require("../registration_validation/frequency");
const { makePollingFunction } = require("./function");
const { makeIntervalManager, getPollIntervalMs } = require("./interval");

/**
 * Error thrown when a task registration is not found in the polling scheduler.
 */
class TaskRegistrationNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found in registrations`);
        this.name = "TaskRegistrationNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../time_duration').TimeDuration} TimeDuration
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../types').Callback} Callback
 */

/** @typedef {import('../types').Registration} Registration */

/**
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 */

/**
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 */
function makePollingScheduler(capabilities, registrations) {
    /** @type {Set<string>} */
    const scheduledTasks = new Set(); // Task names that are enabled. Is a subset of names in `registrations`.
    const dt = capabilities.datetime;

    // Create task executor for handling task execution
    const taskExecutor = makeTaskExecutor(capabilities, (transformation) => mutateTasks(capabilities, registrations, transformation));

    // Create polling function with lifecycle management
    const pollFunction = makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor);
    const intervalManager = makeIntervalManager(pollFunction, capabilities);

    function start() {
        intervalManager.start();
    }

    function stop() {
        intervalManager.stop();
    }

    return {
        /**
         * Schedule a new task.
         * @param {string} name
         * @returns {Promise<void>}
         */
        async schedule(name) {
            const found = registrations.get(name);
            if (found === undefined) {
                throw new TaskRegistrationNotFoundError(name);
            }

            // Parse and validate cron expression from registration
            const parsedCron = found.parsedCron;

            // Validate task frequency against polling frequency
            validateTaskFrequency(parsedCron, getPollIntervalMs(), dt);

            if (scheduledTasks.size === 0) {
                start();
            }

            scheduledTasks.add(name);
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async cancel(name) {
            const existed = scheduledTasks.delete(name);
            if (scheduledTasks.size === 0) {
                stop();
            }
            return existed;
        },

        async stopLoop() {
            stop();
        },

        /**
         * Cancel all tasks and stop polling.
         * @returns {Promise<number>}
         */
        async cancelAll() {
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
