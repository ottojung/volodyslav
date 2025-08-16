/**
 * Polling based cron scheduler.
 */

const { parseCronExpression, matchesCronExpression } = require("./parser");
const datetime = require("../datetime");
const {
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
} = require("./polling_scheduler_errors");
const { fromMilliseconds } = require("../time_duration");
const runtimeStateStorage = require("../runtime_state_storage");
const { isTryDeserializeError, UnsupportedVersionError } = require("../runtime_state_storage/structure");

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
 * @typedef {object} PreloadedRecord
 * @property {string} cronExpression
 * @property {number} retryDelayMs
 * @property {Date} [lastSuccessTime]
 * @property {Date} [lastFailureTime]
 * @property {Date} [lastAttemptTime]
 * @property {Date} [pendingRetryUntil]
 */

/**
 * Loads runtime state from storage and extracts preloaded task records.
 * @param {object} capabilities
 * @param {Logger} capabilities.logger
 * @param {import('../filesystem/reader').FileReader} capabilities.reader
 * @param {import('../filesystem/checker').FileChecker} capabilities.checker
 * @returns {Promise<Map<string, PreloadedRecord>>}
 */
async function loadRuntimeState(capabilities) {
    /** @type {Map<string, PreloadedRecord>} */
    const preloadedRecords = new Map();

    try {
        // Get the runtime state repository path
        const repositoryPath = await runtimeStateStorage.ensureAccessible(capabilities);
        const stateFilePath = require("path").join(repositoryPath, "..", "state.json");
        
        // Check if state file exists
        const fileExists = await capabilities.checker.fileExists(stateFilePath);
        if (!fileExists) {
            capabilities.logger.logInfo({ taskCount: 0 }, "SchedulerStatePreload");
            return preloadedRecords;
        }

        // Read and parse the state file
        const stateContent = await capabilities.reader.readFileAsText(stateFilePath);
        const stateData = JSON.parse(stateContent);
        
        // Deserialize using the runtime state structure
        const deserializeResult = require("../runtime_state_storage/structure").tryDeserialize(stateData);
        
        if (isTryDeserializeError(deserializeResult)) {
            if (deserializeResult instanceof UnsupportedVersionError) {
                capabilities.logger.logError(
                    { version: deserializeResult.version },
                    "UnsupportedRuntimeStateVersion"
                );
                capabilities.logger.logInfo({ taskCount: 0 }, "SchedulerStatePreload");
                return preloadedRecords;
            } else {
                throw deserializeResult;
            }
        }

        // Log any task validation errors
        for (const taskError of deserializeResult.taskErrors) {
            const logData = {
                reason: taskError.message
            };
            if (taskError.taskIndex !== undefined) {
                logData.index = taskError.taskIndex;
            }
            if (taskError.field && "name" in stateData.tasks?.[taskError.taskIndex]) {
                logData.name = stateData.tasks[taskError.taskIndex].name;
            }
            capabilities.logger.logWarning(logData, "SkippedInvalidPersistedTask");
        }

        // Convert valid task records to preloaded records
        const dt = datetime.make();
        for (const taskRecord of deserializeResult.state.tasks) {
            /** @type {PreloadedRecord} */
            const preloaded = {
                cronExpression: taskRecord.cronExpression,
                retryDelayMs: taskRecord.retryDelayMs,
            };
            
            // Convert DateTime objects to native Date objects
            if (taskRecord.lastSuccessTime) {
                preloaded.lastSuccessTime = dt.toNativeDate(taskRecord.lastSuccessTime);
            }
            if (taskRecord.lastFailureTime) {
                preloaded.lastFailureTime = dt.toNativeDate(taskRecord.lastFailureTime);
            }
            if (taskRecord.lastAttemptTime) {
                preloaded.lastAttemptTime = dt.toNativeDate(taskRecord.lastAttemptTime);
            }
            if (taskRecord.pendingRetryUntil) {
                preloaded.pendingRetryUntil = dt.toNativeDate(taskRecord.pendingRetryUntil);
            }
            
            preloadedRecords.set(taskRecord.name, preloaded);
        }

        capabilities.logger.logInfo({ taskCount: preloadedRecords.size }, "SchedulerStatePreload");
        return preloadedRecords;
        
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logWarning({ message }, "StateLoadFailed");
        capabilities.logger.logInfo({ taskCount: 0 }, "SchedulerStatePreload");
        return preloadedRecords;
    }
}

/**
 * @param {object} capabilities
 * @param {Logger} capabilities.logger
 * @param {import('../filesystem/reader').FileReader} capabilities.reader
 * @param {import('../filesystem/checker').FileChecker} capabilities.checker
 * @param {{pollIntervalMs?: number}} [options]
 */
function makePollingScheduler(capabilities, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    /** @type {Map<string, Task>} */
    const tasks = new Map();
    let interval = /** @type {NodeJS.Timeout?} */ (null);
    const dt = datetime.make();

    // Lazy loading state
    /** @type {Map<string, PreloadedRecord>|null} */
    let preloadedRecords = null;
    let stateLoadAttempted = false;
    /** @type {Promise<void>|null} */
    let loadingPromise = null;

    /**
     * Ensures preloaded records are loaded (called lazily on first schedule).
     */
    async function ensurePreloadedRecords() {
        if (!stateLoadAttempted) {
            stateLoadAttempted = true;
            preloadedRecords = await loadRuntimeState(capabilities);
        }
    }

    /**
     * Triggers loading if not already started.
     */
    function triggerLoading() {
        if (!loadingPromise) {
            loadingPromise = ensurePreloadedRecords().catch((error) => {
                capabilities.logger.logWarning(
                    { message: error instanceof Error ? error.message : String(error) },
                    "StateLoadFailed"
                );
            });
        }
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
         * @returns {string}
         */
        schedule(name, cronExpression, callback, retryDelay) {
            if (typeof name !== "string" || name.trim() === "") {
                throw new ScheduleInvalidNameError(name);
            }
            if (tasks.has(name)) {
                capabilities.logger.logWarning({ name }, "Duplicate registration attempt");
                throw new ScheduleDuplicateTaskError(name);
            }

            // Trigger state loading if not already started
            triggerLoading();

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

            // Check for preloaded record and apply if it matches (if already loaded)
            if (preloadedRecords) {
                const preloaded = preloadedRecords.get(name);
                if (preloaded) {
                    // Remove from preloaded to avoid reuse
                    preloadedRecords.delete(name);
                    
                    // Check if cron expression and retry delay match
                    const retryDelayMs = retryDelay.toMilliseconds();
                    if (preloaded.cronExpression === cronExpression && preloaded.retryDelayMs === retryDelayMs) {
                        // Apply preloaded timing fields
                        task.lastSuccessTime = preloaded.lastSuccessTime;
                        task.lastFailureTime = preloaded.lastFailureTime;
                        task.lastAttemptTime = preloaded.lastAttemptTime;
                        task.pendingRetryUntil = preloaded.pendingRetryUntil;
                    } else {
                        // Log mismatch warning
                        capabilities.logger.logWarning({
                            name,
                            persistedCron: preloaded.cronExpression,
                            providedCron: cronExpression,
                            persistedRetryDelayMs: preloaded.retryDelayMs,
                            providedRetryDelayMs: retryDelayMs
                        }, "PersistedTaskMismatch");
                    }
                }
            }

            tasks.set(name, task);
            start();
            return name;
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {boolean}
         */
        cancel(name) {
            const existed = tasks.delete(name);
            if (tasks.size === 0) {
                stop();
            }
            return existed;
        },

        /**
         * Cancel all tasks and stop polling.
         * @returns {number}
         */
        cancelAll() {
            const count = tasks.size;
            tasks.clear();
            stop();
            return count;
        },

        /**
         * Get information about scheduled tasks.
         * @returns {Array<{name:string,cronExpression:string,running:boolean,lastSuccessTime?:string,lastFailureTime?:string,lastAttemptTime?:string,pendingRetryUntil?:string,modeHint:"retry"|"cron"|"idle"}>}
         */
        getTasks() {
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

