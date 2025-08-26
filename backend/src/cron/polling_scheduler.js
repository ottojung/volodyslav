/**
 * Polling based cron scheduler.
 */

const { parseCronExpression } = require("./parser");
const {
    getMostRecentExecution,
    validateTaskFrequency,
    loadPersistedState,
    mutateTasks,
    makeTaskExecutor,
} = require("./scheduling");
const {
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
} = require("./polling_scheduler_errors");

/**
 * @typedef {import('../logger').Logger} Logger
 * @typedef {import('../time_duration').TimeDuration} TimeDuration
 * @typedef {import('./scheduling/types').CronExpression} CronExpression
 * @typedef {import('../datetime').DateTime} DateTime
 * @typedef {import('./scheduling/types').Callback} Callback
 */

const POLL_INTERVAL_MS = 600000;

/**
 * @typedef {object} Task
 * @property {string} name
 * @property {import('./expression').CronExpressionClass} parsedCron
 * @property {Callback} callback
 * @property {TimeDuration} retryDelay
 * @property {DateTime|undefined} lastSuccessTime
 * @property {DateTime|undefined} lastFailureTime
 * @property {DateTime|undefined} lastAttemptTime
 * @property {DateTime|undefined} pendingRetryUntil
 * @property {DateTime|undefined} lastEvaluatedFire
 */

/**
 * @typedef {import('./scheduling/types').Registration} Registration
 */

/**
 * @typedef {import('./scheduling/types').ParsedRegistrations} ParsedRegistrations
 */

/**
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 */
function makePollingScheduler(capabilities, registrations) {
    /** @type {NodeJS.Timeout | null} */
    let interval = null;
    const dt = capabilities.datetime;
    let stateLoadAttempted = false;
    let pollInProgress = false; // Guard against re-entrant polls

    // Create task executor for handling task execution
    const taskExecutor = makeTaskExecutor(capabilities, (transformation) => mutateTasks(capabilities, registrations, transformation));

    // Lazy load state when first needed
    async function ensureStateLoaded() {
        if (!stateLoadAttempted) {
            stateLoadAttempted = true;
            await loadPersistedState(capabilities, registrations);
        }
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
            }, module.exports.POLL_INTERVAL_MS);
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
            const now = dt.toNativeDate(dt.now());
            let dueRetry = 0;
            let dueCron = 0;
            let skippedRunning = 0;
            let skippedRetryFuture = 0;
            let skippedNotDue = 0;
            // Collect all due tasks for parallel execution
            /** @type {Array<{task: Task, mode: "retry"|"cron"}>} */
            const dueTasks = [];

            for (const task of tasks.values()) {
                // Skip tasks that don't have a callback yet (loaded from persistence)
                if (task.callback === null) {
                    continue;
                }
                if (task.running) {
                    skippedRunning++;
                    capabilities.logger.logDebug({ name: task.name, reason: "running" }, "TaskSkip");
                    continue;
                }

                // Check both cron schedule and retry timing
                const { lastScheduledFire, newLastEvaluatedFire } = getMostRecentExecution(task.parsedCron, now, dt, task.lastEvaluatedFire);

                // Update lastEvaluatedFire cache for performance optimization
                if (newLastEvaluatedFire) {
                    task.lastEvaluatedFire = newLastEvaluatedFire;
                }

                const shouldRunCron = lastScheduledFire &&
                    (!task.lastAttemptTime || task.lastAttemptTime < lastScheduledFire);

                const shouldRunRetry = task.pendingRetryUntil && now.getTime() >= task.pendingRetryUntil.getTime();

                if (shouldRunRetry && shouldRunCron) {
                    // Both are due - choose the mode based on which is earlier (chronologically smaller)
                    if (task.pendingRetryUntil && lastScheduledFire && task.pendingRetryUntil.getTime() < lastScheduledFire.getTime()) {
                        dueTasks.push({ task, mode: "retry" });
                        dueRetry++;
                    } else {
                        dueTasks.push({ task, mode: "cron" });
                        dueCron++;
                    }
                } else if (shouldRunCron) {
                    dueTasks.push({ task, mode: "cron" });
                    dueCron++;
                } else if (shouldRunRetry) {
                    dueTasks.push({ task, mode: "retry" });
                    dueRetry++;
                } else if (task.pendingRetryUntil) {
                    skippedRetryFuture++;
                    capabilities.logger.logDebug({ name: task.name, reason: "retryNotDue" }, "TaskSkip");
                } else {
                    skippedNotDue++;
                    capabilities.logger.logDebug({ name: task.name, reason: "notDue" }, "TaskSkip");
                }
            }

            // Execute all due tasks in parallel
            await taskExecutor.executeTasks(dueTasks);

            capabilities.logger.logDebug(
                {
                    total: tasks.size,
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
         * @param {string} cronExpression
         * @param {Callback} callback
         * @param {TimeDuration} retryDelay
         * @returns {Promise<string>}
         */
        async schedule(name, cronExpression, callback, retryDelay) {
            if (typeof name !== "string" || name.trim() === "") {
                throw new ScheduleInvalidNameError(name);
            }

            // Parse and validate cron expression
            const parsedCron = parseCronExpression(cronExpression);

            // Validate task frequency against polling frequency
            validateTaskFrequency(parsedCron, module.exports.POLL_INTERVAL_MS, dt);

            // Load state first to check for existing tasks from persistence
            await ensureStateLoaded();

            // Check if task exists
            const existingTask = tasks.get(name);
            if (existingTask) {
                // If task exists from persistence without callback, update it
                if (existingTask.callback === null) {
                    existingTask.callback = callback;
                    existingTask.cronExpression = cronExpression;
                    existingTask.parsedCron = parsedCron;
                    existingTask.retryDelay = retryDelay;
                    // NOTE: We preserve execution history fields (lastSuccessTime, etc.)

                    // Persist updated task
                    await persistState();

                    start();
                    return name;
                } else {
                    // Task already has a callback - this is a duplicate
                    capabilities.logger.logWarning({ name }, "Duplicate registration attempt");
                    throw new ScheduleDuplicateTaskError(name);
                }
            }

            /** @type {Task} */
            const task = {
                name,
                cronExpression,
                parsedCron,
                callback,
                retryDelay,
                lastSuccessTime: undefined,
                lastFailureTime: undefined,
                lastAttemptTime: undefined,
                pendingRetryUntil: undefined,
                lastEvaluatedFire: undefined,
                running: false,
            };
            tasks.set(name, task);

            // Persist state after adding task
            await persistState();

            start();
            return name;
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async cancel(name) {
            const existed = tasks.delete(name);
            if (existed) {
                // Persist state after removing task
                await persistState();
            }
            if (tasks.size === 0) {
                stop();
            }
            return existed;
        },

        async stopLoop() {
            await ensureStateLoaded();
            stop();
        },

        /**
         * Cancel all tasks and stop polling.
         * @returns {Promise<number>}
         */
        async cancelAll() {
            const count = tasks.size;
            tasks.clear();
            // Persist the clearing of all tasks to ensure cancelled tasks don't reappear after restart
            await persistState();
            stop();
            return count;
        },

        /**
         * Get information about scheduled tasks.
         * @returns {Promise<Array<{name:string,cronExpression:string,running:boolean,lastSuccessTime?:string,lastFailureTime?:string,lastAttemptTime?:string,pendingRetryUntil?:string,modeHint:"retry"|"cron"|"idle"}>>}
         */
        async getTasks() {
            // Ensure state is loaded before returning task info
            await ensureStateLoaded();

            const now = dt.toNativeDate(dt.now());
            return Array.from(tasks.values()).map((t) => {
                /** @type {"retry"|"cron"|"idle"} */
                let modeHint = "idle";

                const { lastScheduledFire, newLastEvaluatedFire } = getMostRecentExecution(t.parsedCron, now, dt, t.lastEvaluatedFire);

                // Update cache for performance (don't persist here as it's just for reading)
                if (newLastEvaluatedFire) {
                    t.lastEvaluatedFire = newLastEvaluatedFire;
                }
                const shouldRunCron = lastScheduledFire &&
                    (!t.lastAttemptTime || t.lastAttemptTime < lastScheduledFire);
                const shouldRunRetry = t.pendingRetryUntil && now.getTime() >= t.pendingRetryUntil.getTime();

                if (shouldRunRetry && shouldRunCron) {
                    // Both are due - choose mode based on which is earlier (chronologically smaller)
                    if (t.pendingRetryUntil && lastScheduledFire && t.pendingRetryUntil.getTime() < lastScheduledFire.getTime()) {
                        modeHint = "retry";
                    } else {
                        modeHint = "cron";
                    }
                } else if (shouldRunCron) {
                    modeHint = "cron";
                } else if (shouldRunRetry) {
                    modeHint = "retry";
                } else {
                    modeHint = "idle";
                }

                return {
                    name: t.name,
                    cronExpression: t.cronExpression,
                    running: t.running,
                    lastSuccessTime: t.lastSuccessTime?.toISOString(),
                    lastFailureTime: t.lastFailureTime?.toISOString(),
                    lastAttemptTime: t.lastAttemptTime?.toISOString(),
                    pendingRetryUntil: t.pendingRetryUntil?.toISOString(),
                    modeHint,
                };
            });
        },


    };
}

module.exports = {
    makePollingScheduler,
    POLL_INTERVAL_MS,
};

