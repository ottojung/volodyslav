/**
 * Polling based cron scheduler.
 */

const { parseCronExpression, matchesCronExpression, getNextExecution } = require("./parser");
const { transaction } = require("../runtime_state_storage");
const structure = require("../runtime_state_storage/structure");
const time_duration = require("../time_duration");
const {
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    ScheduleFrequencyError,
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
 * @property {boolean} running
 */

/**
 * Get the most recent execution time for a cron expression using efficient forward calculation
 * @param {import('./parser').CronExpressionClass} parsedCron
 * @param {Date} now
 * @param {import('../datetime').Datetime} dt
 * @returns {Date | undefined}
 */
function getMostRecentExecution(parsedCron, now, dt) {
    try {
        // For efficiency, check if current minute matches first
        const currentMinute = new Date(now);
        currentMinute.setSeconds(0, 0);
        
        const currentDt = dt.fromEpochMs(currentMinute.getTime());
        if (matchesCronExpression(parsedCron, currentDt)) {
            return currentMinute;
        }
        
        // Look backward minute by minute for the most recent match
        // Use a reasonable limit to avoid infinite loops
        const maxIterations = 60; // Look back 1 hour max
        
        for (let i = 1; i <= maxIterations; i++) {
            const candidate = new Date(currentMinute.getTime() - (i * 60 * 1000));
            const candidateDt = dt.fromEpochMs(candidate.getTime());
            if (matchesCronExpression(parsedCron, candidateDt)) {
                return candidate;
            }
        }
        
        return undefined;
        
    } catch (error) {
        return undefined;
    }
}

/**
 * Calculate minimum interval between cron executions to validate against polling frequency
 * @param {import('./parser').CronExpressionClass} parsedCron
 * @param {import('../datetime').Datetime} dt
 * @returns {number} Minimum interval in milliseconds
 */
function calculateMinimumCronInterval(parsedCron, dt) {
    try {
        // Start from a known time
        const baseTime = dt.fromEpochMs(new Date("2020-01-01T00:00:00Z").getTime());
        
        // Get first execution from base time
        const firstExecution = getNextExecution(parsedCron, baseTime);
        if (!firstExecution) {
            // If no execution found, assume it's very infrequent (safe to allow)
            return 24 * 60 * 60 * 1000; // 1 day
        }
        
        // Get second execution
        const secondExecution = getNextExecution(parsedCron, firstExecution);
        if (!secondExecution) {
            // Only one execution possible, assume infrequent
            return 24 * 60 * 60 * 1000; // 1 day
        }
        
        // Calculate difference
        const firstMs = dt.toNativeDate(firstExecution).getTime();
        const secondMs = dt.toNativeDate(secondExecution).getTime();
        
        return secondMs - firstMs;
    } catch (error) {
        // If calculation fails (e.g., yearly schedules), assume it's infrequent (safe to allow)
        return 24 * 60 * 60 * 1000; // 1 day
    }
}

/**
 * Validate that task frequency is not higher than polling frequency
 * @param {import('./parser').CronExpressionClass} parsedCron
 * @param {number} pollIntervalMs
 * @param {import('../datetime').Datetime} dt
 * @throws {ScheduleFrequencyError}
 */
function validateTaskFrequency(parsedCron, pollIntervalMs, dt) {
    const minCronInterval = calculateMinimumCronInterval(parsedCron, dt);
    
    if (minCronInterval < pollIntervalMs) {
        throw new ScheduleFrequencyError(minCronInterval, pollIntervalMs);
    }
}

/**
 * Loads persisted task state and builds in-memory tasks map
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {Map<string, Task>} tasks
 * @returns {Promise<void>}
 */
async function loadPersistedState(capabilities, tasks) {
    try {
        await transaction(capabilities, async (storage) => {
            const existingState = await storage.getExistingState();
            let taskCount = 0;
            
            if (existingState === null) {
                // No existing state - start fresh
                capabilities.logger.logInfo({ taskCount: 0 }, "SchedulerStateLoaded");
                return;
            }

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

                    // Check for duplicates
                    if (tasks.has(record.name)) {
                        capabilities.logger.logWarning(
                            { name: record.name },
                            "DuplicateTaskSkipped"
                        );
                        continue;
                    }

                    // Create task object (callback will be set when scheduled)
                    /** @type {Task} */
                    const task = {
                        name: record.name,
                        cronExpression: record.cronExpression,
                        parsedCron,
                        callback: null, // Will be set when task is re-scheduled
                        retryDelay,
                        lastSuccessTime,
                        lastFailureTime,
                        lastAttemptTime,
                        pendingRetryUntil,
                        running: false,
                    };

                    tasks.set(record.name, task);
                    taskCount++;
                    
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logWarning(
                        { name: record.name || "unknown", reason: message },
                        "SkippedInvalidTask"
                    );
                }
            }

            capabilities.logger.logInfo({ taskCount }, "SchedulerStateLoaded");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ message }, "StateReadFailed");
        // Continue running with empty task set
        capabilities.logger.logInfo({ taskCount: 0 }, "SchedulerStateLoaded");
    }
}
/**
 * Persist current task state
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {Map<string, Task>} tasks
 * @returns {Promise<void>}
 */
async function persistCurrentState(capabilities, tasks) {
    try {
        await transaction(capabilities, async (storage) => {
            const currentState = await storage.getCurrentState();
            
            // Convert in-memory tasks to TaskRecord format
            const taskRecords = Array.from(tasks.values()).map(task => {
                /** @type {import('../runtime_state_storage/types').TaskRecord} */
                const record = {
                    name: task.name,
                    cronExpression: task.cronExpression,
                    retryDelayMs: task.retryDelay.toMilliseconds(),
                };

                // Convert Date objects to DateTime and then to ISO strings
                if (task.lastSuccessTime) {
                    record.lastSuccessTime = capabilities.datetime.fromEpochMs(task.lastSuccessTime.getTime());
                }
                if (task.lastFailureTime) {
                    record.lastFailureTime = capabilities.datetime.fromEpochMs(task.lastFailureTime.getTime());
                }
                if (task.lastAttemptTime) {
                    record.lastAttemptTime = capabilities.datetime.fromEpochMs(task.lastAttemptTime.getTime());
                }
                if (task.pendingRetryUntil) {
                    record.pendingRetryUntil = capabilities.datetime.fromEpochMs(task.pendingRetryUntil.getTime());
                }

                return record;
            });

            // Update state with new task records
            const newState = {
                version: currentState.version,
                startTime: currentState.startTime,
                tasks: taskRecords,
            };

            storage.setState(newState);
            
            const serialized = structure.serialize(newState);
            const bytes = JSON.stringify(serialized).length;
            capabilities.logger.logDebug({ taskCount: tasks.size, bytes }, "StatePersisted");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ message }, "StateWriteFailed");
        // Continue running - write failures are non-fatal
    }
}

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
    let runningTasksCount = 0; // Track concurrent executions

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
                const lastFire = getMostRecentExecution(task.parsedCron, now, dt);
                const shouldRunCron = lastFire && 
                    (!task.lastAttemptTime || task.lastAttemptTime < lastFire);
                
                const shouldRunRetry = task.pendingRetryUntil && now.getTime() >= task.pendingRetryUntil.getTime();
                
                if (shouldRunRetry && shouldRunCron) {
                    // Both are due - choose the mode based on which comes first
                    if (task.pendingRetryUntil && lastFire && task.pendingRetryUntil.getTime() <= lastFire.getTime()) {
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
            await executeTasksWithConcurrencyLimit(dueTasks, maxConcurrentTasks);
            
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
     * Execute tasks in parallel with concurrency limit
     * @param {Array<{task: Task, mode: "retry"|"cron"}>} dueTasks
     * @param {number} maxConcurrent
     */
    async function executeTasksWithConcurrencyLimit(dueTasks, maxConcurrent) {
        if (dueTasks.length === 0) return;
        
        // Execute all tasks in parallel if within limit
        if (dueTasks.length <= maxConcurrent && runningTasksCount === 0) {
            const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
            await Promise.all(promises);
            return;
        }
        
        // Use concurrency control
        if (dueTasks.length <= maxConcurrent) {
            // If we have fewer tasks than the limit, just run them all in parallel
            const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
            await Promise.all(promises);
        } else {
            // Use proper concurrency control for more tasks than the limit
            let index = 0;
            const executing = new Set();
            
            while (index < dueTasks.length || executing.size > 0) {
                // Start tasks up to the concurrency limit
                while (executing.size < maxConcurrent && index < dueTasks.length) {
                    const dueTask = dueTasks[index++];
                    if (!dueTask) continue;
                    
                    const { task, mode } = dueTask;
                    const promise = runTask(task, mode);
                    executing.add(promise);
                    
                    // Remove promise when it completes
                    promise.finally(() => executing.delete(promise));
                }
                
                // Wait for at least one task to complete before continuing
                if (executing.size > 0) {
                    await Promise.race(Array.from(executing));
                }
            }
        }
    }

    /**
     * @param {Task} task
     * @param {"retry"|"cron"} mode
     */
    async function runTask(task, mode) {
        if (task.callback === null) {
            capabilities.logger.logWarning({ name: task.name }, "TaskSkippedNoCallback");
            return;
        }
        
        task.running = true;
        runningTasksCount++;
        const startTime = dt.toNativeDate(dt.now());
        task.lastAttemptTime = startTime;
        capabilities.logger.logInfo({ name: task.name, mode }, "TaskRunStarted");
        try {
            const result = task.callback();
            if (result instanceof Promise) {
                await result;
            }
            const end = dt.toNativeDate(dt.now());
            task.lastSuccessTime = end;
            task.lastFailureTime = undefined;
            task.pendingRetryUntil = undefined;
            capabilities.logger.logInfo(
                { name: task.name, mode, durationMs: end.getTime() - startTime.getTime() },
                "TaskRunSuccess"
            );
            // Persist state after success
            try {
                await persistState();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                capabilities.logger.logError({ message }, "StateWriteFailedAfterSuccess");
            }
        } catch (error) {
            const end = dt.toNativeDate(dt.now());
            task.lastFailureTime = end;
            const retryAt = new Date(end.getTime() + task.retryDelay.toMilliseconds());
            task.pendingRetryUntil = retryAt;
            const message = error instanceof Error ? error.message : String(error);
            capabilities.logger.logInfo(
                { name: task.name, mode, errorMessage: message, retryAtISO: retryAt.toISOString() },
                "TaskRunFailure"
            );
            // Persist state after failure
            try {
                await persistState();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                capabilities.logger.logError({ message }, "StateWriteFailedAfterFailure");
            }
        } finally {
            task.running = false;
            runningTasksCount--;
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

        /**
         * Cancel all tasks and stop polling.
         * @returns {Promise<number>}
         */
        async cancelAll() {
            const count = tasks.size;
            tasks.clear();
            // NOTE: We don't persist state after cancelAll to preserve execution history
            // for potential restart. If you want to permanently clear persisted state,
            // use a different method.
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
                
                const lastFire = getMostRecentExecution(t.parsedCron, now, dt);
                const shouldRunCron = lastFire &&
                    (!t.lastAttemptTime || t.lastAttemptTime < lastFire);
                const shouldRunRetry = t.pendingRetryUntil && now.getTime() >= t.pendingRetryUntil.getTime();
                
                if (shouldRunRetry && shouldRunCron) {
                    // Both are due - choose mode based on which comes first
                    if (t.pendingRetryUntil && lastFire && t.pendingRetryUntil.getTime() <= lastFire.getTime()) {
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

