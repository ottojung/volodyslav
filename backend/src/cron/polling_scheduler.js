/**
 * Polling based cron scheduler.
 */

const { parseCronExpression } = require("./parser");
const {
    getMostRecentExecution,
    validateTaskFrequency,
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
    /** @type {Map<string, (() => Promise<void> | void)>} */
    const taskCallbacks = new Map(); // In-memory callback registry only
    /** @type {any} */
    let interval = null;
    const dt = capabilities.datetime; // Use capabilities datetime instead of creating new instance
    let pollInProgress = false; // Guard against re-entrant polls

    /**
     * Apply task updates in a batched transaction
     * @param {Array<{taskName: string, updates: Partial<Task>}>} updates
     * @returns {Promise<void>}
     */
    async function batchUpdateTasks(updates) {
        if (updates.length === 0) return;
        
        await transaction(capabilities, async (storage) => {
            // Load current state from storage within the transaction
            const existingState = await storage.getExistingState();
            
            // Build in-memory tasks map from persisted state
            /** @type {Map<string, Task>} */
            const tasks = new Map();
            
            if (existingState !== null) {
                // Build in-memory tasks from persisted state
                for (const record of existingState.tasks) {
                    try {
                        const task = convertPersistedTaskToTask(record);
                        tasks.set(record.name, task);
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

            // Apply all updates
            for (const { taskName, updates: taskUpdates } of updates) {
                const currentTask = tasks.get(taskName);
                if (currentTask) {
                    /** @type {Task} */
                    const updatedTask = {
                        name: currentTask.name,
                        cronExpression: currentTask.cronExpression,
                        parsedCron: currentTask.parsedCron,
                        callback: currentTask.callback,
                        retryDelay: currentTask.retryDelay,
                        lastSuccessTime: 'lastSuccessTime' in taskUpdates ? taskUpdates.lastSuccessTime : currentTask.lastSuccessTime,
                        lastFailureTime: 'lastFailureTime' in taskUpdates ? taskUpdates.lastFailureTime : currentTask.lastFailureTime,
                        lastAttemptTime: 'lastAttemptTime' in taskUpdates ? taskUpdates.lastAttemptTime : currentTask.lastAttemptTime,
                        pendingRetryUntil: 'pendingRetryUntil' in taskUpdates ? taskUpdates.pendingRetryUntil : currentTask.pendingRetryUntil,
                        lastEvaluatedFire: 'lastEvaluatedFire' in taskUpdates ? taskUpdates.lastEvaluatedFire : currentTask.lastEvaluatedFire,
                        running: 'running' in taskUpdates ? (taskUpdates.running ?? currentTask.running) : currentTask.running,
                    };
                    tasks.set(taskName, updatedTask);
                }
            }

            // Convert tasks back to persistable format and save
            const currentState = await storage.getCurrentState();
            const taskRecords = Array.from(tasks.values()).map(convertTaskToPersistedRecord);

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
            capabilities.logger.logDebug({ taskCount: tasks.size, bytes }, "StatePersisted");
        });
    }

    /**
     * Simple task executor that collects updates and applies them in batch
     * @param {import('../capabilities/root').Capabilities} capabilities
     * @param {number} maxConcurrentTasks
     * @returns {{executeTasks: (dueTasks: Array<{task: Task, mode: "retry"|"cron"}>) => Promise<void>}}
     */
    function makeBatchingTaskExecutor(capabilities, maxConcurrentTasks) {
        const dt = capabilities.datetime;

        /**
         * Execute multiple tasks with concurrency control.
         * @param {Array<{task: Task, mode: "retry"|"cron"}>} dueTasks
         * @returns {Promise<void>}
         */
        async function executeTasks(dueTasks) {
            if (dueTasks.length === 0) return;

            /** @type {Array<{taskName: string, updates: Partial<Task>}>} */
            const batchedUpdates = [];

            /**
             * @param {Task} task
             * @param {"retry"|"cron"} mode
             */
            const executeTask = async (task, mode) => {
                if (task.callback === null) {
                    capabilities.logger.logWarning({ name: task.name }, "TaskSkippedNoCallback");
                    return;
                }

                // Start task execution
                const startTime = dt.toNativeDate(dt.now());
                
                // Mark running and set attempt time
                batchedUpdates.push({ 
                    taskName: task.name,
                    updates: { 
                        running: true,
                        lastAttemptTime: startTime
                    }
                });
                
                capabilities.logger.logInfo({ name: task.name, mode }, "TaskRunStarted");
                
                try {
                    const result = task.callback();
                    if (result instanceof Promise) {
                        await result;
                    }
                    const end = dt.toNativeDate(dt.now());
                    
                    // Update task state on success
                    batchedUpdates.push({
                        taskName: task.name,
                        updates: {
                            lastSuccessTime: end,
                            lastFailureTime: undefined,
                            pendingRetryUntil: undefined,
                            running: false,
                        }
                    });
                    
                    capabilities.logger.logInfo(
                        { name: task.name, mode, durationMs: end.getTime() - startTime.getTime() },
                        "TaskRunSuccess"
                    );
                } catch (error) {
                    const end = dt.toNativeDate(dt.now());
                    const retryAt = new Date(end.getTime() + task.retryDelay.toMilliseconds());
                    const message = error instanceof Error ? error.message : String(error);
                    
                    // Update task state on failure
                    batchedUpdates.push({
                        taskName: task.name,
                        updates: {
                            lastFailureTime: end,
                            pendingRetryUntil: retryAt,
                            running: false,
                        }
                    });
                    
                    capabilities.logger.logInfo(
                        { name: task.name, mode, errorMessage: message, retryAtISO: retryAt.toISOString() },
                        "TaskRunFailure"
                    );
                }
            };

            // Execute all tasks with proper concurrency control
            if (dueTasks.length <= maxConcurrentTasks) {
                // If we have fewer tasks than the limit, just run them all in parallel
                const promises = dueTasks.map(({ task, mode }) => executeTask(task, mode));
                await Promise.all(promises);
            } else {
                // More tasks than concurrency limit - batch execution
                let index = 0;
                const executing = new Set();

                while (index < dueTasks.length || executing.size > 0) {
                    // Start new tasks up to the concurrency limit
                    while (executing.size < maxConcurrentTasks && index < dueTasks.length) {
                        const currentTask = dueTasks[index++];
                        if (currentTask) {
                            const { task, mode } = currentTask;
                            const promise = executeTask(task, mode).finally(() => {
                                executing.delete(promise);
                            });
                            executing.add(promise);
                        }
                    }

                    // Wait for at least one task to complete
                    if (executing.size > 0) {
                        await Promise.race(executing);
                    }
                }
            }

            // Apply all updates in a single batch transaction
            await batchUpdateTasks(batchedUpdates);
        }

        return { executeTasks };
    }

    // Create task executor
    const taskExecutor = makeBatchingTaskExecutor(capabilities, maxConcurrentTasks);

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

        // Get callback from in-memory registry
        const callback = taskCallbacks.get(record.name) || null;

        /** @type {Task} */
        const task = {
            name: record.name,
            cronExpression: record.cronExpression,
            parsedCron,
            callback,
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
            const tasks = new Map();
            
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
                        tasks.set(record.name, task);
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

            // Apply the transformation within the transaction
            const result = transformation(tasks);

            // Convert tasks back to persistable format and save
            const currentState = await storage.getCurrentState();
            const taskRecords = Array.from(tasks.values()).map(convertTaskToPersistedRecord);

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
            capabilities.logger.logDebug({ taskCount: tasks.size, bytes }, "StatePersisted");

            return result;
        });
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
            // Step 1: Load current state and determine what to execute - separate transaction
            const { dueTasks } = await transaction(capabilities, async (storage) => {
                // Load current state from storage within the transaction
                const existingState = await storage.getExistingState();
                
                // Build in-memory tasks map from persisted state
                /** @type {Map<string, Task>} */
                const tasks = new Map();
                
                if (existingState !== null) {
                    // Build in-memory tasks from persisted state
                    for (const record of existingState.tasks) {
                        try {
                            const task = convertPersistedTaskToTask(record);
                            tasks.set(record.name, task);
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

                const now = dt.toNativeDate(dt.now());
                let dueRetry = 0;
                let dueCron = 0;
                let skippedRunning = 0;
                let skippedRetryFuture = 0;
                let skippedNotDue = 0;
                let hasUpdates = false;

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
                    if (newLastEvaluatedFire && (!task.lastEvaluatedFire || newLastEvaluatedFire.getTime() !== task.lastEvaluatedFire.getTime())) {
                        task.lastEvaluatedFire = newLastEvaluatedFire;
                        hasUpdates = true;
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

                // Save any cache updates back to storage only if needed
                if (hasUpdates) {
                    const currentState = await storage.getCurrentState();
                    const taskRecords = Array.from(tasks.values()).map(convertTaskToPersistedRecord);

                    // Update state with new task records
                    const newState = {
                        version: currentState.version,
                        startTime: currentState.startTime,
                        tasks: taskRecords,
                    };

                    storage.setState(newState);
                }

                capabilities.logger.logDebug(
                    {
                        total: tasks.size,
                        dueRetry,
                        dueCron,
                        skippedRunning,
                        skippedRetryFuture,
                        skippedNotDue,
                        skippedConcurrency: 0, // Will be updated after execution
                    },
                    "PollSummary"
                );

                return { dueTasks };
            });

            // Step 2: Execute due tasks completely outside any storage transaction
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
            await modifyTasks((tasks) => {
                const existingTask = tasks.get(name);
                if (existingTask) {
                    // If task exists from persistence without callback, update it
                    if (existingTask.callback === null) {
                        // Register callback in memory
                        taskCallbacks.set(name, callback);
                        
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

                // Register callback in memory for new task
                taskCallbacks.set(name, callback);

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
            
            // Remove callback from memory if task existed
            if (result.existed) {
                taskCallbacks.delete(name);
            }
            
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
            
            // Clear all callbacks from memory
            taskCallbacks.clear();
            
            stop();
            return count;
        },

        /**
         * Get information about scheduled tasks.
         * @returns {Promise<Array<{name:string,cronExpression:string,running:boolean,lastSuccessTime?:string,lastFailureTime?:string,lastAttemptTime?:string,pendingRetryUntil?:string,modeHint:"retry"|"cron"|"idle"}>>}
         */
        async getTasks() {
            return await transaction(capabilities, async (storage) => {
                // Load current state from storage within the transaction
                const existingState = await storage.getExistingState();
                
                // Build in-memory tasks map from persisted state
                /** @type {Map<string, Task>} */
                const tasks = new Map();
                
                if (existingState !== null) {
                    // Build in-memory tasks from persisted state
                    for (const record of existingState.tasks) {
                        try {
                            const task = convertPersistedTaskToTask(record);
                            tasks.set(record.name, task);
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

