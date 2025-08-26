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
    ScheduleInvalidNameError,
} = require("./polling_scheduler_errors");
const { isRunning } = require("./task");

/**
 * @typedef {import('../logger').Logger} Logger
 * @typedef {import('../time_duration').TimeDuration} TimeDuration
 * @typedef {import('./scheduling/types').CronExpression} CronExpression
 * @typedef {import('../datetime').DateTime} DateTime
 * @typedef {import('./scheduling/types').Callback} Callback
 */

const POLL_INTERVAL_MS = 600000;

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
    /** @type {Set<string>} */
    const scheduledTasks = new Set(); // Task names that are enabled. Is a subset of names in `registrations`.
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
            const now = dt.now();
            let dueRetry = 0;
            let dueCron = 0;
            let skippedRunning = 0;
            let skippedRetryFuture = 0;
            let skippedNotDue = 0;

            // Collect all due tasks for parallel execution
            /** @type {Array<{taskName: string, mode: "retry"|"cron"}>} */
            const dueTasks = [];

            await mutateTasks(capabilities, registrations, (tasks) => {
                for (const taskName of scheduledTasks) {
                    const qname = JSON.stringify(taskName);

                    const task = tasks.get(taskName);
                    if (task === undefined) {
                        // FIXME: turn this into a proper error.    
                        throw new Error(`Task ${qname} not found`);
                    }

                    if (isRunning(task)) {
                        skippedRunning++;
                        capabilities.logger.logDebug({ name: taskName, reason: "running" }, "TaskSkip");
                        continue;
                    }

                    // Check both cron schedule and retry timing
                    // FIXME: only use DateTime class, no Date.
                    const lastEvaluatedFireDate = task.lastEvaluatedFire ? dt.toNativeDate(task.lastEvaluatedFire) : undefined;
                    const { lastScheduledFire, newLastEvaluatedFire } = getMostRecentExecution(task.parsedCron, now, dt, lastEvaluatedFireDate);

                    // Update lastEvaluatedFire cache for performance optimization
                    if (newLastEvaluatedFire) {
                        task.lastEvaluatedFire = dt.fromEpochMs(newLastEvaluatedFire.getDate());
                    }

                    const shouldRunCron = lastScheduledFire &&
                        (!task.lastAttemptTime || task.lastAttemptTime.getTime() < lastScheduledFire.getTime());

                    const shouldRunRetry = task.pendingRetryUntil && now.getTime() >= task.pendingRetryUntil.getTime();

                    if (shouldRunRetry && shouldRunCron) {
                        // Both are due - choose the mode based on which is earlier (chronologically smaller)
                        if (task.pendingRetryUntil && lastScheduledFire && task.pendingRetryUntil.getTime() < lastScheduledFire.getTime()) {
                            dueTasks.push({ taskName, mode: "retry" });
                            dueRetry++;
                        } else {
                            dueTasks.push({ taskName, mode: "cron" });
                            dueCron++;
                        }
                    } else if (shouldRunCron) {
                        dueTasks.push({ taskName, mode: "cron" });
                        dueCron++;
                    } else if (shouldRunRetry) {
                        dueTasks.push({ taskName, mode: "retry" });
                        dueRetry++;
                    } else if (task.pendingRetryUntil) {
                        skippedRetryFuture++;
                        capabilities.logger.logDebug({ name: taskName, reason: "retryNotDue" }, "TaskSkip");
                    } else {
                        skippedNotDue++;
                        capabilities.logger.logDebug({ name: taskName, reason: "notDue" }, "TaskSkip");
                    }
                }
            });

            // Execute all due tasks in parallel
            await taskExecutor.executeTasks(dueTasks);

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
         * FIXME: change the signature to accept ONLY the `name`, nothing else.
         * @param {string} name
         * @param {string} cronExpression
         * @param {Callback} _callback
         * @param {TimeDuration} _retryDelay
         * @returns {Promise<void>}
         */
        async schedule(name, cronExpression, _callback, _retryDelay) {
            if (typeof name !== "string" || name.trim() === "") {
                throw new ScheduleInvalidNameError(name);
            }

            const found = registrations.get(name);
            if (found === undefined) {
                // FIXME: turn this into a proper error.    
                throw new Error(`Task ${name} not found.`);
            }

            // Parse and validate cron expression
            const parsedCron = parseCronExpression(cronExpression);

            // Validate task frequency against polling frequency
            validateTaskFrequency(parsedCron, module.exports.POLL_INTERVAL_MS, dt);

            scheduledTasks.add(name);
            start();
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async cancel(name) {
            const existed = scheduledTasks.delete(name);
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
            const count = scheduledTasks.size;
            scheduledTasks.clear();
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

