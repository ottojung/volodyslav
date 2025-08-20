/**
 * Polling based cron scheduler.
 */

const { parseCronExpression } = require("./parser");
const {
    getMostRecentExecution,
    validateTaskFrequency,
    makeTaskExecutor,
} = require("./scheduling");
const {
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
} = require("./polling_scheduler_errors");
const { transaction } = require("../runtime_state_storage");
const structure = require("../runtime_state_storage/structure");
const time_duration = require("../time_duration");

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
    let pollInProgress = false; // Guard against re-entrant polls

    /**
     * Helper function to convert persisted task record to in-memory Task object
     * @param {any} record - Persisted task record
     * @returns {Task}
     */
    function convertPersistedTaskToTask(record) {
        // Parse cron expression
        const parsedCron = parseCronExpression(record.cronExpression);

        // Convert retryDelayMs to TimeDuration
        const retryDelay = time_duration.fromMilliseconds(record.retryDelayMs);

        // Convert DateTime objects to native Date objects
        const lastSuccessTime = record.lastSuccessTime
            ? capabilities.datetime.toNativeDate(record.lastSuccessTime)
            : undefined;

        const lastFailureTime = record.lastFailureTime
            ? capabilities.datetime.toNativeDate(record.lastFailureTime)
            : undefined;

        const lastAttemptTime = record.lastAttemptTime
            ? capabilities.datetime.toNativeDate(record.lastAttemptTime)
            : undefined;

        const pendingRetryUntil = record.pendingRetryUntil
            ? capabilities.datetime.toNativeDate(record.pendingRetryUntil)
            : undefined;

        const lastEvaluatedFire = record.lastEvaluatedFire
            ? capabilities.datetime.toNativeDate(record.lastEvaluatedFire)
            : undefined;

        /** @type {Task} */
        const task = {
            name: record.name,
            cronExpression: record.cronExpression,
            parsedCron,
            callback: null, // Will be set when task is re-registered
            retryDelay,
            lastSuccessTime,
            lastFailureTime,
            lastAttemptTime,
            pendingRetryUntil,
            lastEvaluatedFire,
            running: false, // Never restore running state
        };

        return task;
    }

    /**
     * Helper function to convert in-memory Task to persisted task record
     * @param {Task} task - In-memory task
     * @returns {any} Persisted task record
     */
    function convertTaskToPersistedRecord(task) {
        return {
            name: task.name,
            cronExpression: task.cronExpression,
            retryDelayMs: task.retryDelay.toMilliseconds(),
            lastSuccessTime: task.lastSuccessTime
                ? capabilities.datetime.fromEpochMs(task.lastSuccessTime.getTime())
                : undefined,
            lastFailureTime: task.lastFailureTime
                ? capabilities.datetime.fromEpochMs(task.lastFailureTime.getTime())
                : undefined,
            lastAttemptTime: task.lastAttemptTime
                ? capabilities.datetime.fromEpochMs(task.lastAttemptTime.getTime())
                : undefined,
            pendingRetryUntil: task.pendingRetryUntil
                ? capabilities.datetime.fromEpochMs(task.pendingRetryUntil.getTime())
                : undefined,
            lastEvaluatedFire: task.lastEvaluatedFire
                ? capabilities.datetime.fromEpochMs(task.lastEvaluatedFire.getTime())
                : undefined,
        };
    }

    /**
     * Atomically modify tasks with transactional persistence
     * @template T
     * @param {(tasks: Map<string, Task>) => T} transformation
     * @returns {Promise<T>}
     */
    async function modifyTasks(transformation) {
        return await transaction(capabilities, async (storage) => {
            // Load current state from storage within the transaction
            const existingState = await storage.getExistingState();
            
            // Build in-memory tasks map from persisted state
            /** @type {Map<string, Task>} */
            const currentTasks = new Map();
            
            if (existingState !== null) {
                // Handle migration logging
                if (existingState.version === 1) {
                    capabilities.logger.logInfo(
                        { from: 1, to: 2 },
                        "RuntimeStateMigrated"
                    );
                }

                // Build in-memory tasks from persisted state
                for (const record of existingState.tasks) {
                    try {
                        const task = convertPersistedTaskToTask(record);
                        currentTasks.set(record.name, task);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        capabilities.logger.logError(
                            { taskName: record.name, error: message },
                            "FailedToLoadPersistedTask"
                        );
                        // Continue loading other tasks
                    }
                }
            }

            // Merge with any callbacks that exist in memory for these tasks
            for (const task of currentTasks.values()) {
                const existingTask = tasks.get(task.name);
                if (existingTask && existingTask.callback) {
                    task.callback = existingTask.callback;
                }
            }

            // Apply the transformation within the transaction
            const result = transformation(currentTasks);

            // Update the in-memory tasks map with the results
            tasks.clear();
            for (const [name, task] of currentTasks) {
                tasks.set(name, task);
            }

            // Convert tasks back to persistable format and save
            const currentState = await storage.getCurrentState();
            const taskRecords = Array.from(currentTasks.values()).map(convertTaskToPersistedRecord);

            // Update state with new task records
            const newState = {
                version: currentState.version,
                startTime: currentState.startTime,
                tasks: taskRecords,
            };

            storage.setState(newState);

            // Log the persistence
            const serialized = structure.serialize(newState);
            const bytes = JSON.stringify(serialized).length;
            capabilities.logger.logDebug({ taskCount: currentTasks.size, bytes }, "StatePersisted");

            return result;
        });
    }

    // Create task executor for handling task execution with concurrency limits
    // Create an adapter that converts the task executor's expected interface
    // from updateTask(task, partialUpdates) to our callback-based approach
    /**
     * @param {Task} task
     * @param {Partial<Task>} updates
     */
    async function updateTaskAdapter(task, updates) {
        await modifyTasks((currentTasks) => {
            const currentTask = currentTasks.get(task.name);
            if (currentTask) {
                // Apply partial updates to create updated task
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
                    running: 'running' in updates ? (updates.running ?? currentTask.running) : currentTask.running,
                };
                currentTasks.set(task.name, updatedTask);
            }
        });
    }

    const taskExecutor = makeTaskExecutor(capabilities, maxConcurrentTasks, updateTaskAdapter);

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
            // Load current state and determine what tasks to execute
            const dueTasks = await modifyTasks((currentTasks) => {
                const now = dt.toNativeDate(dt.now());
                let dueRetry = 0;
                let dueCron = 0;
                let skippedRunning = 0;
                let skippedRetryFuture = 0;
                let skippedNotDue = 0;

                // Collect all due tasks for parallel execution
                /** @type {Array<{task: Task, mode: "retry"|"cron"}>} */
                const dueTasks = [];

                for (const task of currentTasks.values()) {
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

                capabilities.logger.logDebug(
                    {
                        total: currentTasks.size,
                        dueRetry,
                        dueCron,
                        skippedRunning,
                        skippedRetryFuture,
                        skippedNotDue,
                        skippedConcurrency: 0, // Will be updated after task execution
                    },
                    "PollSummary"
                );

                return dueTasks;
            });

            // Execute due tasks in parallel with concurrency control
            if (dueTasks.length > 0) {
                await taskExecutor.executeTasks(dueTasks);
            }
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
            await modifyTasks((currentTasks) => {
                const existingTask = currentTasks.get(name);
                if (existingTask) {
                    // If task exists from persistence without callback, update it
                    if (existingTask.callback === null) {
                        // Update existing task with new callback and settings
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
                currentTasks.set(name, task);
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
            const result = await modifyTasks((currentTasks) => {
                const existed = currentTasks.delete(name);
                return { existed, size: currentTasks.size };
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
            const count = await modifyTasks((currentTasks) => {
                const count = currentTasks.size;
                currentTasks.clear();
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
            return await modifyTasks((currentTasks) => {
                const now = dt.toNativeDate(dt.now());
                return Array.from(currentTasks.values()).map((t) => {
                    /** @type {"retry"|"cron"|"idle"} */
                    let modeHint = "idle";

                    const { lastScheduledFire, newLastEvaluatedFire } = getMostRecentExecution(t.parsedCron, now, dt, t.lastEvaluatedFire);

                    // Update cache for performance (this will be persisted since we're in modifyTasks)
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

