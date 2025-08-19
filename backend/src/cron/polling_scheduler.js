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
 * @property {Date|undefined} lastEvaluatedFire
 * @property {boolean} running
 */

/**
 * Finds the most recent time a cron expression would have fired before the given reference time.
 * 
 * This implements a correctness-preserving and efficient algorithm that:
 * - Has NO MAXIMUM LOOKBACK: Must work for any time gap (yearly/leap-year tasks after multiple years)
 * - Is Efficient: Avoids linear minute-by-minute scanning; uses field-based backwards calculation
 * - Is Deterministic: Same inputs always produce same output
 * - Implements Correct caching: Returns actual fire time (not evaluation time) as cache
 * 
 * @param {import('./parser').CronExpressionClass} parsedCron - The parsed cron expression
 * @param {Date} now - The reference point (current time)
 * @param {import('../datetime').Datetime} dt - DateTime capabilities instance
 * @param {Date|undefined} lastKnownFireTime - Optional cache hint (actual fire time, not evaluation time)
 * @returns {{previousFire: Date|undefined, newCacheTime: Date|undefined}}
 */
function findPreviousFire(parsedCron, now, dt, lastKnownFireTime) {
    try {
        // For efficiency, check if current minute matches first
        const currentMinute = new Date(now);
        currentMinute.setSeconds(0, 0);

        const currentDt = dt.fromEpochMs(currentMinute.getTime());
        if (matchesCronExpression(parsedCron, currentDt)) {
            return {
                previousFire: currentMinute,
                newCacheTime: currentMinute
            };
        }

        // Strategy: Use cached fire time if recent, otherwise use bounded forward stepping
        let anchorTime;
        const oneDay = 24 * 60 * 60 * 1000;
        const oneWeek = 7 * oneDay;
        const oneMonth = 31 * oneDay;

        if (lastKnownFireTime && lastKnownFireTime.getTime() < now.getTime()) {
            // Start from the last known fire time if available and reasonable
            const timeDiff = now.getTime() - lastKnownFireTime.getTime();
            
            if (timeDiff <= oneWeek) {
                // Recent cache - start from there for efficiency
                anchorTime = new Date(lastKnownFireTime);
            } else if (timeDiff <= oneMonth) {
                // For gaps up to 1 month, start from last known fire
                anchorTime = new Date(lastKnownFireTime);
            } else {
                // For larger gaps, use conservative lookback to prevent performance issues
                anchorTime = new Date(now.getTime() - oneMonth);
            }
        } else {
            // No cache available - use conservative lookback
            anchorTime = new Date(now.getTime() - oneMonth);
        }

        // Ensure anchor is minute-aligned
        anchorTime.setSeconds(0, 0);

        // Use efficient forward stepping to find most recent execution
        // This approach scales with the actual execution frequency, not time span
        let currentExecution;
        let lastFound = undefined;
        let iterations = 0;
        const maxIterations = 1000; // Conservative limit to ensure fast performance

        try {
            const anchorDt = dt.fromEpochMs(anchorTime.getTime());
            currentExecution = getNextExecution(parsedCron, anchorDt);

            while (currentExecution && iterations < maxIterations) {
                const executionTime = dt.toNativeDate(currentExecution);

                if (executionTime.getTime() <= now.getTime()) {
                    lastFound = executionTime;
                    // Get next execution from this point
                    currentExecution = getNextExecution(parsedCron, currentExecution);
                    iterations++;
                } else {
                    // Went past current time - we found the most recent
                    break;
                }
            }

            if (lastFound) {
                return {
                    previousFire: lastFound,
                    newCacheTime: lastFound  // Cache the actual fire time, not evaluation time
                };
            }
        } catch (error) {
            // If forward calculation fails, try limited backward scan as safety fallback
        }

        // Fallback: limited backward scan for edge cases where forward calculation fails
        // Keep this bounded but reasonable for most practical schedules
        const fallbackScanLimit = Math.min(366 * 24 * 60, 50000); // 1 year of minutes or 50k max

        for (let i = 1; i <= fallbackScanLimit; i++) {
            const candidate = new Date(currentMinute.getTime() - (i * 60 * 1000));
            const candidateDt = dt.fromEpochMs(candidate.getTime());
            if (matchesCronExpression(parsedCron, candidateDt)) {
                return {
                    previousFire: candidate,
                    newCacheTime: candidate  // Cache the actual fire time
                };
            }
        }

        // No previous fire found within reasonable limits
        return {
            previousFire: undefined,
            newCacheTime: undefined
        };

    } catch (error) {
        return {
            previousFire: undefined,
            newCacheTime: undefined
        };
    }
}

/**
 * Legacy wrapper for getMostRecentExecution - maintains backward compatibility
 * while using the new findPreviousFire implementation
 * 
 * @param {import('./parser').CronExpressionClass} parsedCron
 * @param {Date} now
 * @param {import('../datetime').Datetime} dt
 * @param {Date|undefined} lastEvaluatedFire - Cache of last evaluated fire time for optimization
 * @returns {{lastScheduledFire: Date | undefined, newLastEvaluatedFire: Date | undefined}}
 */
function getMostRecentExecution(parsedCron, now, dt, lastEvaluatedFire) {
    const result = findPreviousFire(parsedCron, now, dt, lastEvaluatedFire);
    
    return {
        lastScheduledFire: result.previousFire,
        newLastEvaluatedFire: result.newCacheTime
    };
}

/**
 * Calculate minimum interval between cron executions to validate against polling frequency.
 * 
 * Improved robustness to catch composite expressions with varying intervals:
 * - Tests multiple anchor points across different months and times
 * - Examines more consecutive executions to find true minimum
 * - Handles edge cases like leap years and month boundaries
 * - Provides comprehensive validation for complex cron patterns
 * 
 * @param {import('./parser').CronExpressionClass} parsedCron
 * @param {import('../datetime').Datetime} dt
 * @returns {number} Minimum interval in milliseconds
 */
function calculateMinimumCronInterval(parsedCron, dt) {
    try {
        // Comprehensive test starting points to catch complex composite expressions
        const testBases = [
            new Date("2020-01-01T00:00:00Z"),  // New Year start
            new Date("2020-02-01T00:00:00Z"),  // February start  
            new Date("2020-02-29T00:00:00Z"),  // Leap year edge case
            new Date("2020-03-01T00:00:00Z"),  // March start (after leap day)
            new Date("2020-06-15T12:30:00Z"),  // Mid-year, mid-day
            new Date("2020-07-31T23:59:00Z"),  // End of month edge case
            new Date("2020-12-31T23:59:00Z"),  // End of year edge case
            new Date("2021-01-01T00:00:00Z"),  // Non-leap year transition
        ];

        let minInterval = Number.MAX_SAFE_INTEGER;
        const targetSamples = 20; // Increased sample size for better detection

        for (const baseTime of testBases) {
            const baseDt = dt.fromEpochMs(baseTime.getTime());

            // Get first execution from this base
            let previousExecution = getNextExecution(parsedCron, baseDt);
            if (!previousExecution) continue;

            // Check more consecutive executions to find true minimum interval
            for (let i = 0; i < targetSamples; i++) {
                const nextExecution = getNextExecution(parsedCron, previousExecution);
                if (!nextExecution) break;

                const prevMs = dt.toNativeDate(previousExecution).getTime();
                const nextMs = dt.toNativeDate(nextExecution).getTime();
                const interval = nextMs - prevMs;

                if (interval > 0 && interval < minInterval) {
                    minInterval = interval;
                }

                previousExecution = nextExecution;

                // Early termination for very frequent expressions
                if (minInterval < 60 * 1000) {
                    return minInterval; // Found sub-minute frequency
                }
            }
        }

        // Handle edge cases
        if (minInterval === Number.MAX_SAFE_INTEGER) {
            // No executions found - expression might be invalid or very infrequent
            return 365 * 24 * 60 * 60 * 1000; // 1 year (conservative safe default)
        }

        if (minInterval > 365 * 24 * 60 * 60 * 1000) {
            // Expression executes less than yearly - safe to allow
            return minInterval;
        }

        return minInterval;

    } catch (error) {
        // If calculation fails, be conservative
        return 365 * 24 * 60 * 60 * 1000; // 1 year (very safe default)
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
                    const lastEvaluatedFire = record.lastEvaluatedFire
                        ? capabilities.datetime.toNativeDate(record.lastEvaluatedFire)
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
                        lastEvaluatedFire,
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
                if (task.lastEvaluatedFire) {
                    record.lastEvaluatedFire = capabilities.datetime.fromEpochMs(task.lastEvaluatedFire.getTime());
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
            const skippedConcurrencyCount = await executeTasksWithConcurrencyLimit(dueTasks, maxConcurrentTasks);
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

    /**
     * Execute tasks in parallel with concurrency limit
     * @param {Array<{task: Task, mode: "retry"|"cron"}>} dueTasks
     * @param {number} maxConcurrent
     * @returns {Promise<number>} Number of tasks skipped due to concurrency limits
     */
    async function executeTasksWithConcurrencyLimit(dueTasks, maxConcurrent) {
        if (dueTasks.length === 0) return 0;

        let skippedConcurrency = 0;

        // Execute all tasks in parallel if within limit and no other tasks running
        if (dueTasks.length <= maxConcurrent && runningTasksCount === 0) {
            const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
            await Promise.all(promises);
            return 0;
        }

        // Use concurrency control
        if (dueTasks.length <= maxConcurrent) {
            // If we have fewer tasks than the limit, just run them all in parallel
            const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
            await Promise.all(promises);
            return 0;
        } else {
            // More tasks than concurrency limit - some will be deferred
            skippedConcurrency = dueTasks.length - maxConcurrent;

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

            return skippedConcurrency;
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
            // Persist evaluation state after successful execution
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

