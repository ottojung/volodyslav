/**
 * Polling based cron scheduler.
 */

const { parseCronExpression } = require("./parser");
const {
    getMostRecentExecution,
    validateTaskFrequency,
    loadPersistedState,
    persistCurrentState,
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
 * @property {string} name
 * @property {string} cronExpression
 * @property {import('./expression').CronExpressionClass} parsedCron
 * @property {(() => Promise<void> | void) | null} callback
 * @property {TimeDuration} retryDelay
 * @property {Date|undefined} lastSuccessTime
 * @property {Date|undefined} lastFailureTime
 * @property {Date|undefined} lastAttemptTime
 * @property {Date|undefined} pendingRetryUntil
 * @property {Date|undefined} lastEvaluatedFire
 * @property {boolean} running
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
     * Atomically modify tasks with atomic persistence
     * @template T
     * @param {(tasks: Map<string, Task>) => T} transformation
     * @returns {Promise<T>}
     */
    async function modifyTasks(transformation) {
        // Ensure state is loaded before modifying
        await ensureStateLoaded();
        
        // Apply transformation to in-memory tasks
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
            // Ensure state is loaded before processing tasks
            await ensureStateLoaded();
            
            const now = dt.toNativeDate(dt.now());
            let dueRetry = 0;
            let dueCron = 0;
            let skippedRunning = 0;
            let skippedRetryFuture = 0;
            let skippedNotDue = 0;
            let skippedConcurrency = 0;
            
            // Collect due tasks for concurrency management
            /** @type {Array<Task>} */
            const dueTasks = [];
            
            // Find due tasks
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
                        dueTasks.push(task);
                        dueRetry++;
                    } else {
                        dueTasks.push(task);
                        dueCron++;
                    }
                } else if (shouldRunCron) {
                    dueTasks.push(task);
                    dueCron++;
                } else if (shouldRunRetry) {
                    dueTasks.push(task);
                    dueRetry++;
                } else if (task.pendingRetryUntil) {
                    skippedRetryFuture++;
                    capabilities.logger.logDebug({ name: task.name, reason: "retryNotDue" }, "TaskSkip");
                } else {
                    skippedNotDue++;
                    capabilities.logger.logDebug({ name: task.name, reason: "notDue" }, "TaskSkip");
                }
            }

            // Execute tasks with concurrency control
            const tasksToExecute = dueTasks.slice(0, maxConcurrentTasks);
            skippedConcurrency = Math.max(0, dueTasks.length - maxConcurrentTasks);
            
            // Start all tasks in parallel but don't wait for them to complete
            // This allows poll() to return while tasks are still running
            const taskPromises = tasksToExecute.map(task => executeTaskDirectly(task));
            
            // Start all promises but don't await them - let them run in background
            // This ensures poll() returns quickly while tasks continue executing
            taskPromises.forEach(promise => {
                promise.catch(error => {
                    // Log any unexpected errors in background task execution
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logError({ error: message }, "BackgroundTaskError");
                });
            });

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

    /**
     * Execute a task directly from the tasks map without extracting references
     * @param {Task} task
     */
    async function executeTaskDirectly(task) {
        const startTime = dt.toNativeDate(dt.now());
        
        // Mark as running before execution
        task.running = true;
        task.lastAttemptTime = startTime;

        capabilities.logger.logInfo({ name: task.name }, "TaskRunStarted");
        
        try {
            // Execute callback directly from task
            if (task.callback) {
                const result = task.callback();
                if (result instanceof Promise) {
                    await result;
                }
            }
            const end = dt.toNativeDate(dt.now());
            
            // Update task state directly and persist
            task.lastSuccessTime = end;
            task.lastFailureTime = undefined;
            task.pendingRetryUntil = undefined;
            task.running = false;
            
            // Persist state changes
            await persistState();
            
            capabilities.logger.logInfo(
                { name: task.name, durationMs: end.getTime() - startTime.getTime() },
                "TaskRunSuccess"
            );
        } catch (error) {
            const end = dt.toNativeDate(dt.now());
            const message = error instanceof Error ? error.message : String(error);
            
            // Update task state directly and persist
            const retryAt = new Date(end.getTime() + task.retryDelay.toMilliseconds());
            task.lastFailureTime = end;
            task.pendingRetryUntil = retryAt;
            task.running = false;
            
            // Persist state changes
            await persistState();
            
            capabilities.logger.logInfo(
                { name: task.name, errorMessage: message },
                "TaskRunFailure"
            );
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
                        existingTask.callback = callback;
                        existingTask.cronExpression = cronExpression;
                        existingTask.parsedCron = parsedCron;
                        existingTask.retryDelay = retryDelay;
                        // NOTE: We preserve execution history fields (lastSuccessTime, etc.)
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
            const result = await modifyTasks((tasks) => {
                const existed = tasks.delete(name);
                return { existed, size: tasks.size };
            });
            
            if (result.size === 0) {
                stop();
            }
            return result.existed;
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

