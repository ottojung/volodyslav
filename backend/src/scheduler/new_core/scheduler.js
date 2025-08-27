/**
 * Core scheduler implementation.
 * Provides polling-based cron scheduling with retry capabilities.
 */

const { validateTaskFrequency } = require('../new_cron/frequency_validator');
const { makeTaskRunner } = require('./task_runner');
const { mutateTasks, isRunning } = require('./state_manager');
const { getMostRecentExecution } = require('./previous_fire_calculator');
const {
    ScheduleInvalidNameError,
    TaskNotFoundError,
} = require('../new_errors');

/** @typedef {import('../new_types/task_types').ParsedRegistrations} ParsedRegistrations */
/** @typedef {import('../new_types/task_types').Callback} Callback */

const POLL_INTERVAL_MS = 600000; // 10 minutes

/**
 * Create a polling scheduler for the given registrations.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 */
function makePollingScheduler(capabilities, registrations) {
    /** @type {NodeJS.Timeout | null} */
    let interval = null;
    /** @type {Set<string>} */
    const scheduledTasks = new Set(); // Task names that are enabled. Is a subset of names in `registrations`.
    const dt = capabilities.datetime;
    let pollInProgress = false; // Guard against re-entrant polls

    // Create task runner for handling task execution
    const taskRunner = makeTaskRunner(capabilities, (transformation) => mutateTasks(capabilities, registrations, transformation));

    // Validate all task frequencies during initialization
    for (const registration of registrations.values()) {
        validateTaskFrequency(registration.name, registration.parsedCron.original, POLL_INTERVAL_MS);
    }

    function start() {
        if (interval === null) {
            interval = setInterval(async () => {
                try {
                    await poll();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logError({ errorMessage: message }, `Unexpected poll error: ${message}`);
                }
            }, POLL_INTERVAL_MS);
            
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
            let dueRetry = 0;
            let dueCron = 0;
            let skippedRunning = 0;
            let skippedRetryFuture = 0;
            let skippedNotDue = 0;

            // Collect all due tasks for parallel execution
            /** @type {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} */
            const dueTasks = [];

            await mutateTasks(capabilities, registrations, (tasks) => {
                for (const taskName of scheduledTasks) {
                    const task = tasks.get(taskName);
                    if (task === undefined) {
                        throw new TaskNotFoundError(taskName);
                    }

                    if (isRunning(task)) {
                        skippedRunning++;
                        capabilities.logger.logDebug({ name: taskName, reason: "running" }, "TaskSkip");
                        continue;
                    }

                    // Check both cron schedule and retry timing
                    const lastEvaluatedFireDate = task.lastEvaluatedFire ? task.lastEvaluatedFire : undefined;
                    const { lastScheduledFire, newLastEvaluatedFire } = getMostRecentExecution(task.parsedCron, now, dt, lastEvaluatedFireDate);

                    // Update lastEvaluatedFire cache for performance optimization
                    if (newLastEvaluatedFire) {
                        task.lastEvaluatedFire = newLastEvaluatedFire;
                    }

                    const shouldRunCron = lastScheduledFire &&
                        (!task.lastAttemptTime || task.lastAttemptTime.getTime() < lastScheduledFire.getTime());

                    const shouldRunRetry = task.pendingRetryUntil && now.getTime() >= task.pendingRetryUntil.getTime();
                    const callback = task.callback;

                    if (shouldRunRetry && shouldRunCron) {
                        // Both are due - choose the mode based on which is earlier (chronologically smaller)
                        if (task.pendingRetryUntil && lastScheduledFire && task.pendingRetryUntil.getTime() < lastScheduledFire.getTime()) {
                            dueTasks.push({ taskName, mode: "retry", callback });
                            dueRetry++;
                        } else {
                            dueTasks.push({ taskName, mode: "cron", callback });
                            dueCron++;
                        }
                    } else if (shouldRunCron) {
                        dueTasks.push({ taskName, mode: "cron", callback });
                        dueCron++;
                    } else if (shouldRunRetry) {
                        dueTasks.push({ taskName, mode: "retry", callback });
                        dueRetry++;
                    } else if (task.pendingRetryUntil) {
                        skippedRetryFuture++;
                        capabilities.logger.logDebug({ name: taskName, reason: "retryNotDue" }, "TaskSkip");
                    } else {
                        skippedNotDue++;
                        capabilities.logger.logDebug({ name: taskName, reason: "notDue" }, "TaskSkip");
                    }
                }
                return tasks; // Return unchanged tasks after collecting due tasks
            });

            // Execute all due tasks in parallel
            await taskRunner.executeTasks(dueTasks);

            capabilities.logger.logDebug(
                {
                    due: dueTasks.length,
                    dueRetry,
                    dueCron,
                    skippedRunning,
                    skippedRetryFuture,
                    skippedNotDue,
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
            if (!found) {
                throw new TaskNotFoundError(name);
            }

            const wasEmpty = scheduledTasks.size === 0;
            scheduledTasks.add(name);

            if (wasEmpty) {
                start();
            }
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