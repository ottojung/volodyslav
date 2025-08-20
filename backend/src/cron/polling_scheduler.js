/**
 * Polling based cron scheduler.
 */

const { parseCronExpression } = require("./parser");
const {
    getMostRecentExecution,
    validateTaskFrequency,
    loadPersistedState,
    persistCurrentState,
    makeTaskExecutor,
} = require("./scheduling");
const {
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
} = require("./polling_scheduler_errors");

/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../time_duration/structure').TimeDuration} TimeDuration */

const POLL_INTERVAL_MS = 600000;

/**
 * @typedef {object} Task
 * @property {readonly string} name
 * @property {readonly string} cronExpression
 * @property {readonly import('./expression').CronExpressionClass} parsedCron
 * @property {readonly (() => Promise<void> | void) | null} callback
 * @property {readonly TimeDuration} retryDelay
 * @property {readonly Date|undefined} lastSuccessTime
 * @property {readonly Date|undefined} lastFailureTime
 * @property {readonly Date|undefined} lastAttemptTime
 * @property {readonly Date|undefined} pendingRetryUntil
 * @property {readonly Date|undefined} lastEvaluatedFire
 * @property {readonly boolean} running
 */







/**
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {{pollIntervalMs?: number, maxConcurrentTasks?: number}} [options]
 */
function makePollingScheduler(capabilities, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const maxConcurrentTasks = options.maxConcurrentTasks ?? 10; // Default concurrency limit
    /** @type {Map<string, Task>} */
    const tasks = new Map();
    /** @type {any} */
    let interval = null;
    const dt = capabilities.datetime; // Use capabilities datetime instead of creating new instance
    let stateLoadAttempted = false;
    let pollInProgress = false; // Guard against re-entrant polls

    /**
     * Atomically update a specific task with partial updates
     * @param {Task} taskToUpdate
     * @param {Partial<Task>} updates
     * @returns {Promise<void>}
     */
    async function updateTask(taskToUpdate, updates) {
        await modifyTasks((tasks) => {
            const currentTask = tasks.get(taskToUpdate.name);
            if (currentTask) {
                // Create new task object with updates
                /** @type {Task} */
                const updatedTask = {
                    name: currentTask.name,
                    cronExpression: currentTask.cronExpression,
                    parsedCron: currentTask.parsedCron,
                    callback: currentTask.callback,
                    retryDelay: currentTask.retryDelay,
                    lastSuccessTime: 'lastSuccessTime' in updates ? updates.lastSuccessTime : currentTask.lastSuccessTime,
                    lastFailureTime: 'lastFailureTime' in updates ? updates.lastFailureTime : currentTask.lastFailureTime,
                    lastAttemptTime: 'lastAttemptTime' in updates ? updates.lastAttemptTime : currentTask.lastAttemptTime,
                    pendingRetryUntil: 'pendingRetryUntil' in updates ? updates.pendingRetryUntil : currentTask.pendingRetryUntil,
                    lastEvaluatedFire: 'lastEvaluatedFire' in updates ? updates.lastEvaluatedFire : currentTask.lastEvaluatedFire,
                    running: 'running' in updates ? updates.running : currentTask.running,
                };
                tasks.set(taskToUpdate.name, updatedTask);
            }
        });
    }

    // Create task executor for handling task execution with concurrency limits
    const taskExecutor = makeTaskExecutor(capabilities, maxConcurrentTasks, updateTask);

    // Lazy load state when first needed
    async function ensureStateLoaded() {
        if (!stateLoadAttempted) {
            stateLoadAttempted = true;
            await loadPersistedState(capabilities, tasks);
        }
    }

    // Persist current state
    async function persistState() {
        await persistCurrentState(capabilities, tasks);
    }

    /**
     * Atomically modify tasks with transactional persistence
     * @template T
     * @param {(tasks: Map<string, Task>) => T} transformation
     * @returns {Promise<T>}
     */
    async function modifyTasks(transformation) {
        // Ensure state is loaded before modifying
        await ensureStateLoaded();
        
        // Apply transformation and get result
        const result = transformation(tasks);
        
        // Persist the changes atomically
        await persistState();
        
        return result;
    }

    function start() {
        if (interval === null) {
            interval = setInterval(async () => {
                try {
                    await poll();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logError({ errorMessage: message }, "UnexpectedPollError");
                }
            }, pollIntervalMs);
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
            // Ensure state is loaded before polling
            await ensureStateLoaded();
            
            const now = dt.toNativeDate(dt.now());
            let dueRetry = 0;
            let dueCron = 0;
            let skippedRunning = 0;
            let skippedRetryFuture = 0;
            let skippedNotDue = 0;
            let skippedConcurrency = 0;

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

            // Execute due tasks in parallel with concurrency control
            const skippedConcurrencyCount = await taskExecutor.executeTasks(dueTasks);
            skippedConcurrency = skippedConcurrencyCount;

            capabilities.logger.logDebug(
                {
                    total: tasks.size,
                    dueRetry,
                    dueCron,
                    skippedRunning,
                    skippedRetryFuture,
                    skippedNotDue,
                    skippedConcurrency,
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
         * @param {() => Promise<void> | void} callback
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
            validateTaskFrequency(parsedCron, pollIntervalMs, dt);

            // Use modifyTasks for atomic state checking and modification
            await modifyTasks((tasks) => {
                const existingTask = tasks.get(name);
                if (existingTask) {
                    // If task exists from persistence without callback, update it
                    if (existingTask.callback === null) {
                        // Create new task object with updated properties, preserving execution history
                        /** @type {Task} */
                        const updatedTask = {
                            name: existingTask.name,
                            cronExpression,
                            parsedCron,
                            callback,
                            retryDelay,
                            lastSuccessTime: existingTask.lastSuccessTime,
                            lastFailureTime: existingTask.lastFailureTime,
                            lastAttemptTime: existingTask.lastAttemptTime,
                            pendingRetryUntil: existingTask.pendingRetryUntil,
                            lastEvaluatedFire: existingTask.lastEvaluatedFire,
                            running: existingTask.running,
                        };
                        tasks.set(name, updatedTask);
                        return; // Success case
                    } else {
                        // Task already has a callback - this is a duplicate
                        capabilities.logger.logWarning({ name }, "Duplicate registration attempt");
                        throw new ScheduleDuplicateTaskError(name);
                    }
                }

                // Create new task
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
            });

            start();
            return name;
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async cancel(name) {
            const existed = await modifyTasks((tasks) => {
                return tasks.delete(name);
            });
            if (tasks.size === 0) {
                stop();
            }
            return existed;
        },

        /**
         * Cancel all tasks and stop polling.
         * @returns {Promise<number>}
         */
        async cancelAll() {
            const count = await modifyTasks((tasks) => {
                const count = tasks.size;
                tasks.clear();
                return count;
            });
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

        /**
         * Manual poll function for testing
         * @internal
         */
        async _poll() {
            return await poll();
        },
    };
}

module.exports = {
    makePollingScheduler,
    POLL_INTERVAL_MS,
};

