/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { mutateTasks } = require("./persistence");
const { isScheduleDuplicateTaskError } = require("./registration_validation");
const { matchesCronExpression } = require("./calculator");
const memconst = require("../memconst");

/**
 * Error for task scheduling failures.
 */
class ScheduleTaskError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "ScheduleTaskError";
        this.details = details;
    }
}

/**
 * Error for scheduler stop failures.
 */
class StopSchedulerError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "StopSchedulerError";
        this.details = details;
    }
}

const { validateRegistrations } = require("./registration_validation");
const { validateTasksAgainstPersistedStateInner } = require("./state_validation");

/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */
/** @typedef {import('./types').Capabilities} Capabilities */
/** @typedef {import('./types').ParsedRegistrations} ParsedRegistrations */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @param {() => Capabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {ReturnType<makePollingScheduler> | null} */
    let pollingScheduler = null;

    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * Validate registrations and check against persisted state.
     * @param {Registration[]} registrations
     * @param {Capabilities} capabilities
     * @returns {Promise<{persistedTasks: import('../runtime_state_storage/types').TaskRecord[] | undefined}>}
     */
    async function validateAndCheckPersistedState(registrations, capabilities) {
        validateRegistrations(registrations, capabilities);

        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        async function getStorage(storage) {
            return await storage.getExistingState();
        }

        const currentState = await capabilities.state.transaction(getStorage);
        const persistedTasks = currentState?.tasks;

        // Always validate registrations against persisted state (unless first-time with empty state)
        if (persistedTasks === undefined) {
            capabilities.logger.logInfo(
                {
                    registeredTaskCount: registrations.length,
                    taskNames: registrations.map(([name]) => name)
                },
                "First-time scheduler initialization: registering initial tasks"
            );
        } else {
            // Validate registrations match persisted state
            capabilities.logger.logDebug(
                {
                    persistedTaskCount: persistedTasks.length,
                    registrationCount: registrations.length
                },
                "Validating task registrations against persisted state"
            );
            validateTasksAgainstPersistedStateInner(registrations, persistedTasks);
        }

        return { persistedTasks };
    }

    /**
     * Parse registrations into internal format.
     * @param {Registration[]} registrations
     * @returns {ParsedRegistrations}
     */
    function parseRegistrations(registrations) {
        /** @type {ParsedRegistrations} */
        const parsedRegistrations = new Map();
        registrations.forEach(([name, cronExpression, callback, retryDelay]) =>
            parsedRegistrations.set(name, {
                name,
                parsedCron: parseCronExpression(cronExpression),
                callback,
                retryDelay
            }));
        return parsedRegistrations;
    }

    /**
     * Schedule all tasks and handle errors.
     * @param {Registration[]} registrations
     * @param {ReturnType<makePollingScheduler>} pollingScheduler
     * @param {Capabilities} capabilities
     * @returns {Promise<{scheduledCount: number, skippedCount: number}>}
     */
    async function scheduleAllTasks(registrations, pollingScheduler, capabilities) {
        let scheduledCount = 0;
        let skippedCount = 0;

        for (const [name, cronExpression, , retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name);
                scheduledCount++;
                capabilities.logger.logDebug(
                    {
                        taskName: name,
                        cronExpression,
                        retryDelayMs: retryDelay.toMillis()
                    },
                    "Task scheduled successfully"
                );
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (isScheduleDuplicateTaskError(error)) {
                    skippedCount++;
                    capabilities.logger.logDebug(
                        { taskName: name },
                        "Task already scheduled - scheduler already initialized"
                    );
                } else {
                    // Enhanced error context for debugging
                    const errorObj = error instanceof Error ? error : new Error(String(error));
                    throw new ScheduleTaskError(`Failed to schedule task '${name}': ${errorObj.message}`, { name, cronExpression, cause: errorObj });
                }
            }
        }

        return { scheduledCount, skippedCount };
    }

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations) {
        const capabilities = getCapabilitiesMemo();
        const parsedRegistrations = parseRegistrations(registrations);

        // Handle polling scheduler lifecycle
        if (pollingScheduler !== null) {
            // Scheduler already running
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized"
            );
            // Still validate registrations against persisted state for consistency.
            await validateAndCheckPersistedState(registrations, capabilities);
            return;
        } else {
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations);
        }

        // Validate input and check persisted state
        const { persistedTasks } = await validateAndCheckPersistedState(registrations, capabilities);

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        if (persistedTasks === undefined) {
            // Persist tasks during first initialization.
            // Handle special first-startup semantics:
            // - If task cron exactly matches current time, allow execution
            // - Otherwise prevent immediate execution but allow next scheduled execution
            await mutateTasks(capabilities, parsedRegistrations, async (tasks) => {
                const now = capabilities.datetime.now();
                
                for (const task of tasks.values()) {
                    const cronMatches = matchesCronExpression(task.parsedCron, now);
                    
                    if (cronMatches) {
                        // Task should execute immediately since cron matches current time
                        // Leave lastAttemptTime undefined so it will execute
                        // Set lastSuccessTime to now to prevent "running" status
                        task.lastSuccessTime = now;
                        capabilities.logger.logDebug(
                            { taskName: task.name },
                            "First startup: task cron matches current time, allowing execution"
                        );
                    } else {
                        // Task should not execute immediately
                        // Set lastAttemptTime to now to prevent immediate execution
                        task.lastAttemptTime = now;
                        // Also set lastSuccessTime to prevent "running" status
                        task.lastSuccessTime = now;
                        capabilities.logger.logDebug(
                            { taskName: task.name },
                            "First startup: task cron does not match current time, preventing execution"
                        );
                    }
                }
                return undefined;
            });
        }

        // Schedule all tasks
        const { scheduledCount, skippedCount } = await scheduleAllTasks(registrations, pollingScheduler, capabilities);

        capabilities.logger.logDebug(
            {
                totalRegistrations: registrations.length,
                scheduledCount,
                skippedCount
            },
            "Scheduler initialization completed"
        );
    }

    /**
     * Stop the scheduler gracefully with enhanced error handling and logging.
     * @type {Stop}
     */
    async function stop() {
        const capabilities = getCapabilitiesMemo();
        if (pollingScheduler !== null) {
            try {
                capabilities.logger.logInfo(
                    {},
                    "Stopping scheduler gracefully"
                );

                await pollingScheduler.stopLoop();
                pollingScheduler = null;

                capabilities.logger.logInfo({}, "Scheduler stopped successfully");
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                // Still clean up state even if stop failed
                pollingScheduler = null;
                throw new StopSchedulerError(`Failed to stop scheduler: ${error.message}`, { cause: error });
            }
        } else {
            capabilities.logger.logDebug({}, "Scheduler already stopped or not initialized");
        }
    }

    return {
        initialize,
        stop,
    };
}

module.exports = {
    make,
    isScheduleDuplicateTaskError,
};