/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { mutateTasks } = require("./persistence");
const { isScheduleDuplicateTaskError } = require("./registration_validation");
const { generateSchedulerIdentifier } = require("./scheduler_identifier");
const { isRunning } = require("./task");
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
const { analyzeStateChanges } = require("./state_validation");

/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */
/** @typedef {import('./types').SchedulerCapabilities} SchedulerCapabilities */
/** @typedef {import('./types').ParsedRegistrations} ParsedRegistrations */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @param {() => SchedulerCapabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {ReturnType<makePollingScheduler> | null} */
    let pollingScheduler = null;
    
    /** @type {string | null} */
    let schedulerIdentifier = null;

    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * Detect and restart tasks that were running under a different scheduler instance.
     * @param {SchedulerCapabilities} capabilities
     * @param {string} currentSchedulerIdentifier
     * @returns {Promise<void>}
     */
    async function detectAndRestartOrphanedTasks(capabilities, currentSchedulerIdentifier) {
        await mutateTasks(capabilities, new Map(), (tasks) => {
            let restartedCount = 0;
            
            for (const task of tasks.values()) {
                if (isRunning(task) && 
                    (!task.schedulerIdentifier || task.schedulerIdentifier !== currentSchedulerIdentifier)) {
                    
                    // This task was running under a different scheduler instance or has no identifier
                    capabilities.logger.logWarning(
                        { 
                            taskName: task.name,
                            previousSchedulerIdentifier: task.schedulerIdentifier || "unknown",
                            currentSchedulerIdentifier: currentSchedulerIdentifier
                        },
                        "ACHTUNG: THIS TASK DID NOT FINISH RUNNING, I'M RESTARTING IT NOW!"
                    );
                    
                    // Unmark the task as running by clearing lastAttemptTime
                    task.lastAttemptTime = undefined;
                    task.schedulerIdentifier = undefined;
                    restartedCount++;
                }
            }
            
            if (restartedCount > 0) {
                capabilities.logger.logInfo(
                    { restartedTaskCount: restartedCount },
                    "Restarted orphaned tasks from previous scheduler instance"
                );
            }
            
            return undefined;
        });
    }

    /**
     * Analyze and potentially override persisted state with registrations.
     * @param {Registration[]} registrations
     * @param {SchedulerCapabilities} capabilities
     * @returns {Promise<{persistedTasks: import('../runtime_state_storage/types').TaskRecord[] | undefined, shouldOverride: boolean}>}
     */
    async function analyzeAndOverridePersistedState(registrations, capabilities) {
        validateRegistrations(registrations);

        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        async function getStorage(storage) {
            return await storage.getExistingState();
        }

        const currentState = await capabilities.state.transaction(getStorage);
        const persistedTasks = currentState?.tasks;

        // Analyze state changes and determine if override is needed
        if (persistedTasks === undefined) {
            capabilities.logger.logInfo(
                {
                    registeredTaskCount: registrations.length,
                    taskNames: registrations.map(([name]) => name)
                },
                "First-time scheduler initialization: registering initial tasks"
            );
            return { persistedTasks, shouldOverride: false };
        } else {
            // Analyze registrations against persisted state
            capabilities.logger.logDebug(
                {
                    persistedTaskCount: persistedTasks.length,
                    registrationCount: registrations.length
                },
                "Analyzing task registrations against persisted state"
            );
            
            const { shouldOverride } = analyzeStateChanges(registrations, persistedTasks, capabilities);
            return { persistedTasks, shouldOverride };
        }
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
     * @param {SchedulerCapabilities} capabilities
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

        // Generate scheduler identifier if not already done
        if (schedulerIdentifier === null) {
            schedulerIdentifier = generateSchedulerIdentifier(capabilities);
            capabilities.logger.logDebug(
                { schedulerIdentifier },
                "Generated scheduler identifier"
            );
        }

        // Handle polling scheduler lifecycle
        if (pollingScheduler !== null) {
            // Scheduler already running
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized"
            );
            // Still analyze registrations against persisted state for consistency.
            await analyzeAndOverridePersistedState(registrations, capabilities);
            return;
        } else {
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);
        }

        // Detect and restart orphaned tasks first
        await detectAndRestartOrphanedTasks(capabilities, schedulerIdentifier);

        // Analyze input and override persisted state if needed
        const { persistedTasks, shouldOverride } = await analyzeAndOverridePersistedState(registrations, capabilities);

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        if (persistedTasks === undefined || shouldOverride) {
            // Persist tasks during first initialization or when override is needed.
            await mutateTasks(capabilities, parsedRegistrations, async () => undefined);
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
};