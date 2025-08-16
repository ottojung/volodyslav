/**
 * Polling based cron scheduler.
 */

const { parseCronExpression, matchesCronExpression } = require("./parser");
const datetime = require("../datetime");
const { transaction } = require("../runtime_state_storage");
const structure = require("../runtime_state_storage/structure");
const time_duration = require("../time_duration");
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
 * @property {() => Promise<void> | void} callback
 * @property {TimeDuration} retryDelay
 * @property {Date|undefined} lastSuccessTime
 * @property {Date|undefined} lastFailureTime
 * @property {Date|undefined} lastAttemptTime
 * @property {Date|undefined} pendingRetryUntil
 * @property {boolean} running
 */

/**
 * @param {import('./parser').CronExpressionClass} parsedCron
 * @param {Date} now
 * @returns {Date | undefined}
 */
function getMostRecentExecution(parsedCron, now) {
    const dt = datetime.make();
    const candidate = new Date(now.getTime());
    candidate.setSeconds(0, 0);
    const max = 366 * 24 * 60;
    for (let i = 0; i < max; i++) {
        const candidateDt = dt.fromEpochMs(candidate.getTime());
        if (candidate.getTime() <= now.getTime() && matchesCronExpression(parsedCron, candidateDt)) {
            return new Date(candidate.getTime());
        }
        candidate.setMinutes(candidate.getMinutes() - 1);
    }
    return undefined;
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
                    
                    // Convert ISO strings to Date objects
                    const lastSuccessTime = record.lastSuccessTime 
                        ? capabilities.datetime.toNativeDate(capabilities.datetime.fromISOString(record.lastSuccessTime))
                        : undefined;
                    const lastFailureTime = record.lastFailureTime 
                        ? capabilities.datetime.toNativeDate(capabilities.datetime.fromISOString(record.lastFailureTime))
                        : undefined;
                    const lastAttemptTime = record.lastAttemptTime 
                        ? capabilities.datetime.toNativeDate(capabilities.datetime.fromISOString(record.lastAttemptTime))
                        : undefined;
                    const pendingRetryUntil = record.pendingRetryUntil 
                        ? capabilities.datetime.toNativeDate(capabilities.datetime.fromISOString(record.pendingRetryUntil))
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
 * @param {object} capabilities
 * @param {Logger} capabilities.logger
 * @param {{pollIntervalMs?: number}} [options]
 */
function makePollingScheduler(capabilities, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    /** @type {Map<string, Task>} */
    const tasks = new Map();
    let interval = /** @type {NodeJS.Timeout?} */ (null);
    const dt = datetime.make();
    let stateLoadAttempted = false;

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
            interval = setInterval(poll, pollIntervalMs);
        }
    }

    function stop() {
        if (interval !== null) {
            clearInterval(interval);
            interval = null;
        }
    }

    function poll() {
        const now = dt.toNativeDate(dt.now());
        let dueRetry = 0;
        let dueCron = 0;
        let skippedRunning = 0;
        let skippedRetryFuture = 0;
        let skippedNotDue = 0;
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
            if (task.pendingRetryUntil) {
                if (now.getTime() >= task.pendingRetryUntil.getTime()) {
                    dueRetry++;
                    runTask(task, "retry").catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        capabilities.logger.logError({ name: task.name, errorMessage: message }, "UnexpectedTaskError");
                    });
                } else {
                    skippedRetryFuture++;
                    capabilities.logger.logDebug({ name: task.name, reason: "retryNotDue" }, "TaskSkip");
                }
                continue;
            }
            const lastFire = getMostRecentExecution(task.parsedCron, now);
            if (
                lastFire &&
                (!task.lastAttemptTime || (task.lastSuccessTime !== undefined && task.lastSuccessTime < lastFire))
            ) {
                dueCron++;
                runTask(task, "cron").catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logError({ name: task.name, errorMessage: message }, "UnexpectedTaskError");
                });
            } else {
                skippedNotDue++;
                capabilities.logger.logDebug({ name: task.name, reason: "notDue" }, "TaskSkip");
            }
        }
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
            await persistState();
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
            await persistState();
        } finally {
            task.running = false;
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
            
            // Load state first to check for existing tasks from persistence
            await ensureStateLoaded();
            
            // Check if task exists
            const existingTask = tasks.get(name);
            if (existingTask) {
                // If task exists from persistence without callback, update it
                if (existingTask.callback === null) {
                    existingTask.callback = callback;
                    existingTask.cronExpression = cronExpression;
                    existingTask.parsedCron = parseCronExpression(cronExpression);
                    existingTask.retryDelay = retryDelay;
                    
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
            
            const parsedCron = parseCronExpression(cronExpression);
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
            if (count > 0) {
                // Persist state after clearing tasks
                await persistState();
                capabilities.logger.logDebug({ clearedTasks: count }, "CancelAllPersisted");
            }
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
                if (t.pendingRetryUntil) {
                    modeHint = now.getTime() >= t.pendingRetryUntil.getTime() ? "retry" : "idle";
                } else {
                    const lastFire = getMostRecentExecution(t.parsedCron, now);
                    if (
                        lastFire &&
                        (!t.lastAttemptTime || (t.lastSuccessTime !== undefined && t.lastSuccessTime < lastFire))
                    ) {
                        modeHint = "cron";
                    } else {
                        modeHint = "idle";
                    }
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

