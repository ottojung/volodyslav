/**
 * Polling based cron scheduler.
 */

const { mutateTasks } = require("./state_persistence");
const { makeTaskExecutor } = require("./task_executor");
const { validateTaskFrequency } = require("./frequency_validator");
const { evaluateTasksForExecution } = require("./task_execution");
const { ScheduleInvalidNameError } = require("./registration_validation");

/**
 * Error thrown when a task is not found in the runtime task map.
 */
class TaskNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found`);
        this.name = "TaskNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * @typedef {import('../logger').Logger} Logger
 * @typedef {import('../time_duration').TimeDuration} TimeDuration
 * @typedef {import('./types').CronExpression} CronExpression
 * @typedef {import('../datetime').DateTime} DateTime
 * @typedef {import('./types').Callback} Callback
 */

const POLL_INTERVAL_MS = 600000;

/**
 * @typedef {import('./types').Registration} Registration
 */

/**
 * @typedef {import('./types').ParsedRegistrations} ParsedRegistrations
 */

/**
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 */
function makePollingScheduler(capabilities, registrations) {
    /** @type {NodeJS.Timeout | null} */
    let interval = null;
    /** @type {Set<string>} */
    const scheduledTasks = new Set(); // Task names that are enabled. Is a subset of names in `registrations`.
    const dt = capabilities.datetime;
    let pollInProgress = false; // Guard against re-entrant polls

    // Create task executor for handling task execution
    const taskExecutor = makeTaskExecutor(capabilities, (transformation) => mutateTasks(capabilities, registrations, transformation));

    function start() {
        if (interval === null) {
            interval = setInterval(async () => {
                try {
                    await poll();
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

    async function poll() {
        // Guard against re-entrant polls
        if (pollInProgress) {
            capabilities.logger.logDebug({ reason: "pollInProgress" }, "PollSkipped");
            return;
        }

        pollInProgress = true;
        try {
            const now = dt.now();
            /** @type {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} */
            let dueTasks = [];
            /** @type {{dueRetry: number, dueCron: number, skippedRunning: number, skippedRetryFuture: number, skippedNotDue: number}} */
            let stats = {
                dueRetry: 0,
                dueCron: 0,
                skippedRunning: 0,
                skippedRetryFuture: 0,
                skippedNotDue: 0,
            };

            // Evaluate which tasks should be executed
            await mutateTasks(capabilities, registrations, (tasks) => {
                const result = evaluateTasksForExecution(tasks, scheduledTasks, now, dt, capabilities);
                dueTasks = result.dueTasks;
                stats = result.stats;
            });

            // Execute all due tasks in parallel
            await taskExecutor.executeTasks(dueTasks);

            capabilities.logger.logDebug(
                {
                    due: dueTasks.length,
                    dueRetry: stats.dueRetry,
                    dueCron: stats.dueCron,
                    skippedRunning: stats.skippedRunning,
                    skippedRetryFuture: stats.skippedRetryFuture,
                    skippedNotDue: stats.skippedNotDue,
                },
                "PollSummary"
            );
        } finally {
            pollInProgress = false;
        }
    }

    return {
        /**
         * Schedule a new task.
         * @param {string} name
         * @returns {Promise<void>}
         */
        async schedule(name) {
            if (typeof name !== "string" || name.trim() === "") {
                throw new ScheduleInvalidNameError(name);
            }

            const found = registrations.get(name);
            if (found === undefined) {
                throw new TaskNotFoundError(name);
            }

            // Parse and validate cron expression from registration
            const parsedCron = found.parsedCron;

            // Validate task frequency against polling frequency
            validateTaskFrequency(parsedCron, module.exports.POLL_INTERVAL_MS, dt);

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
    POLL_INTERVAL_MS,
};

