/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { mutateTasks } = require("./persistence");
const { isScheduleDuplicateTaskError } = require("./registration_validation");
const { generateSchedulerIdentifier } = require("./scheduler_identifier");
const { fromMinutes } = require("../datetime");
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
     * Uses mutateTasks for proper task materialization. Should only be called when state is clean.
     * @param {ParsedRegistrations} parsedRegistrations
     * @param {SchedulerCapabilities} capabilities
     * @param {string} currentSchedulerIdentifier
     * @returns {Promise<void>}
     */
    async function detectAndRestartOrphanedTasks(parsedRegistrations, capabilities, currentSchedulerIdentifier) {
        let restartedCount = 0;
        
        await mutateTasks(capabilities, parsedRegistrations, (tasks) => {
            for (const [taskName, task] of tasks) {
                // Check if this task appears to be running (has lastAttemptTime but different/missing scheduler ID)
                const hasLastAttemptTime = task.lastAttemptTime !== undefined;
                const isFromDifferentScheduler = !task.schedulerIdentifier || 
                    task.schedulerIdentifier !== currentSchedulerIdentifier;
                
                if (hasLastAttemptTime && isFromDifferentScheduler) {
                    // This task was running under a different scheduler instance or has no identifier
                    capabilities.logger.logWarning(
                        { 
                            taskName: taskName,
                            previousSchedulerIdentifier: task.schedulerIdentifier || "unknown",
                            currentSchedulerIdentifier: currentSchedulerIdentifier
                        },
                        "Task was interrupted during shutdown and will be restarted"
                    );
                    
                    // Unmark the task as running by clearing lastAttemptTime and schedulerIdentifier
                    task.lastAttemptTime = undefined;
                    task.schedulerIdentifier = undefined;
                    restartedCount++;
                }
            }
            
            return undefined; // No return value needed
        });
        
        if (restartedCount > 0) {
            capabilities.logger.logInfo(
                { restartedTaskCount: restartedCount },
                "Restarted orphaned tasks from previous scheduler instance"
            );
        }
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

        // Analyze input and override persisted state if needed
        const { persistedTasks, shouldOverride } = await analyzeAndOverridePersistedState(registrations, capabilities);

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        if (persistedTasks === undefined || shouldOverride) {
            // When overriding, we need to create fresh tasks from registrations
            // without trying to materialize potentially incompatible existing tasks
            if (shouldOverride) {
                // Direct state override - create fresh tasks from registrations
                // but preserve any unknown tasks from the previous state
                // Also detect and restart orphaned tasks as part of the override process
                await capabilities.state.transaction(async (storage) => {
                    const currentState = await storage.getExistingState();
                    const now = capabilities.datetime.now();
                    const lastMinute = now.subtract(fromMinutes(1));
                    
                    // Start with existing tasks (unknown ones will be preserved)
                    const existingTasks = currentState?.tasks || [];
                    const registeredTaskNames = new Set(Array.from(parsedRegistrations.keys()));
                    
                    // Separate existing tasks into registered and unknown
                    const unknownTasks = existingTasks.filter(task => !registeredTaskNames.has(task.name));
                    const existingRegisteredTasks = existingTasks.filter(task => registeredTaskNames.has(task.name));
                    
                    // Create fresh tasks for registered tasks, but preserve orphaned task restart work
                    const freshTasks = [];
                    let orphanedTasksRestarted = 0;
                    
                    for (const registration of parsedRegistrations.values()) {
                        // Check if this task already exists and was potentially orphaned
                        const existingTask = existingRegisteredTasks.find(task => task.name === registration.name);
                        
                        if (existingTask) {
                            // Check for orphaned task and restart if needed
                            const hasLastAttemptTime = existingTask.lastAttemptTime !== undefined;
                            const isFromDifferentScheduler = !existingTask.schedulerIdentifier || 
                                existingTask.schedulerIdentifier !== schedulerIdentifier;
                            
                            if (hasLastAttemptTime && isFromDifferentScheduler) {
                                capabilities.logger.logWarning(
                                    { 
                                        taskName: existingTask.name,
                                        previousSchedulerIdentifier: existingTask.schedulerIdentifier || "unknown",
                                        currentSchedulerIdentifier: schedulerIdentifier
                                    },
                                    "Task was interrupted during shutdown and will be restarted"
                                );
                                orphanedTasksRestarted++;
                                
                                // Preserve the existing task but clear orphaned state and update configuration
                                freshTasks.push({
                                    ...existingTask,
                                    cronExpression: registration.parsedCron.original,
                                    retryDelayMs: registration.retryDelay.toMillis(),
                                    lastAttemptTime: undefined,
                                    schedulerIdentifier: undefined,
                                });
                            } else {
                                // Preserve the existing task and update the configuration to match registration
                                freshTasks.push({
                                    ...existingTask,
                                    cronExpression: registration.parsedCron.original,
                                    retryDelayMs: registration.retryDelay.toMillis(),
                                });
                            }
                        } else {
                            // Create a completely fresh task
                            freshTasks.push({
                                name: registration.name,
                                cronExpression: registration.parsedCron.original,
                                retryDelayMs: registration.retryDelay.toMillis(),
                                lastAttemptTime: lastMinute,
                                lastSuccessTime: lastMinute,
                            });
                        }
                    }
                    
                    // Combine preserved unknown tasks with fresh/updated registered tasks
                    const allTasks = [...unknownTasks, ...freshTasks];
                    
                    // Create new state, using current state as base if it exists
                    const newState = currentState ? {
                        ...currentState,
                        tasks: allTasks,
                    } : {
                        version: 1,
                        startTime: now,
                        tasks: allTasks,
                    };
                    storage.setState(newState);
                    
                    capabilities.logger.logDebug({ 
                        freshTaskCount: freshTasks.length,
                        unknownTaskCount: unknownTasks.length,
                        totalTaskCount: allTasks.length,
                        orphanedTasksRestarted
                    }, "State overridden: updated registered tasks and preserved unknown tasks");
                    
                    if (orphanedTasksRestarted > 0) {
                        capabilities.logger.logInfo(
                            { restartedTaskCount: orphanedTasksRestarted },
                            "Restarted orphaned tasks from previous scheduler instance"
                        );
                    }
                });
            } else {
                // First initialization - use mutateTasks as normal
                await mutateTasks(capabilities, parsedRegistrations, async () => undefined);
            }
        } else {
            // No override needed - state matches registrations perfectly
            // Run orphaned task detection using mutateTasks since state is clean
            await detectAndRestartOrphanedTasks(parsedRegistrations, capabilities, schedulerIdentifier);
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