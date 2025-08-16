/**
 * Polling based cron scheduler.
 */

const { parseCronExpression, matchesCronExpression } = require("./parser");
const datetime = require("../datetime");
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
 * Simple task state for persistence.
 * @typedef {object} TaskState
 * @property {string} [lastSuccessTime]
 * @property {string} [lastFailureTime] 
 * @property {string} [lastAttemptTime]
 * @property {string} [pendingRetryUntil]
 */

/**
 * Loads simple scheduler state from JSON file.
 * @param {object} capabilities
 * @param {import('../filesystem/reader').FileReader} capabilities.reader
 * @param {import('../filesystem/checker').FileChecker} capabilities.checker
 * @param {import('../environment').Environment} capabilities.environment
 * @returns {Map<string, TaskState>}
 */
function loadSchedulerState(capabilities) {
    try {
        const stateFile = require("path").join(capabilities.environment.workingDirectory(), "scheduler_state.json");
        const fileExists = capabilities.checker.fileExists(stateFile);
        if (!fileExists) {
            return new Map();
        }
        
        const content = capabilities.reader.readFileAsText(stateFile);
        const data = JSON.parse(content);
        return new Map(Object.entries(data));
    } catch {
        return new Map();
    }
}

/**
 * @param {object} capabilities
 * @param {Logger} capabilities.logger
 * @param {import('../filesystem/reader').FileReader} capabilities.reader
 * @param {import('../filesystem/checker').FileChecker} capabilities.checker
 * @param {import('../environment').Environment} capabilities.environment
 * @param {{pollIntervalMs?: number}} [options]
 */
function makePollingScheduler(capabilities, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    /** @type {Map<string, Task>} */
    const tasks = new Map();
    let interval = /** @type {NodeJS.Timeout?} */ (null);
    const dt = datetime.make();

    // Load state once during creation
    const savedState = loadSchedulerState(capabilities);

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

            // Restore state if available
            const state = savedState.get(name);
            if (state) {
                if (state.lastSuccessTime) task.lastSuccessTime = new Date(state.lastSuccessTime);
                if (state.lastFailureTime) task.lastFailureTime = new Date(state.lastFailureTime);
                if (state.lastAttemptTime) task.lastAttemptTime = new Date(state.lastAttemptTime);
                if (state.pendingRetryUntil) task.pendingRetryUntil = new Date(state.pendingRetryUntil);
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

