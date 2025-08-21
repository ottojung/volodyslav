/**
 * Declarative scheduler that exposes only a single initialization entrypoint.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 */

const cronScheduler = require("../cron");
const memconst = require("../memconst");
const { transaction } = require("../runtime_state_storage");
const { ScheduleInvalidNameError } = require("../cron/polling_scheduler_errors");

/**
 * Error thrown when the task list provided to initialize() differs from persisted runtime state.
 */
class TaskListMismatchError extends Error {
    /**
     * @param {string} message
     * @param {object} mismatchDetails
     * @param {string[]} mismatchDetails.missing - Tasks in persisted state but not in registrations
     * @param {string[]} mismatchDetails.extra - Tasks in registrations but not in persisted state
     * @param {Array<{name: string, field: string, expected: any, actual: any}>} mismatchDetails.differing - Tasks with differing properties
     */
    constructor(message, mismatchDetails) {
        super(message);
        this.name = "TaskListMismatchError";
        this.mismatchDetails = mismatchDetails;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskListMismatchError}
 */
function isTaskListMismatchError(object) {
    return object instanceof TaskListMismatchError;
}

/** @typedef {import('../time_duration/structure').TimeDuration} TimeDuration */
/** @typedef {import('./tasks').Capabilities} Capabilities */

/**
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler with task registrations
 * @property {Stop} stop - Stops the scheduler and cleans up resources
 */

/**
 * Registration tuple defining a scheduled task.
 * @typedef {[string, string, () => Promise<void>, TimeDuration]} Registration
 * @example
 * // Schedule a daily backup task at 2 AM
 * const registration = [
 *   "daily-backup",           // Task name (must be unique)
 *   "0 2 * * *",             // Cron expression (daily at 2:00 AM)
 *   async () => { ... },     // Async callback function
 *   fromMinutes(30)          // Retry delay (30 minutes)
 * ];
 */

/**
 * Task identity for comparison between registrations and persisted state.
 * @typedef {object} TaskIdentity
 * @property {string} name - Unique task name
 * @property {string} cronExpression - Cron expression for scheduling
 * @property {number} retryDelayMs - Retry delay in milliseconds
 */

/**
 * Converts a registration to a TaskIdentity for comparison
 * @param {Registration} registration
 * @returns {TaskIdentity}
 */
function registrationToTaskIdentity(registration) {
    const [name, cronExpression, , retryDelay] = registration;
    return {
        name,
        cronExpression,
        retryDelayMs: retryDelay.toMilliseconds(),
    };
}

/**
 * Converts a persisted TaskRecord to a TaskIdentity for comparison
 * @param {import('../runtime_state_storage/types').TaskRecord} taskRecord
 * @returns {TaskIdentity}
 */
function taskRecordToTaskIdentity(taskRecord) {
    return {
        name: taskRecord.name,
        cronExpression: taskRecord.cronExpression,
        retryDelayMs: taskRecord.retryDelayMs,
    };
}

/**
 * Compares two TaskIdentity objects for equality
 * @param {TaskIdentity} a
 * @param {TaskIdentity} b
 * @returns {boolean}
 */
function taskIdentitiesEqual(a, b) {
    return (a.name === b.name &&
        a.cronExpression === b.cronExpression &&
        a.retryDelayMs === b.retryDelayMs);
}

/**
 * Validates that registrations match persisted runtime state (inner implementation)
 * @param {Registration[]} registrations
 * @param {import('../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @returns {void}
 * @throws {TaskListMismatchError} if tasks don't match
 */
function validateTasksAgainstPersistedStateInner(registrations, persistedTasks) {
    // Early exit optimization for empty arrays
    if (registrations.length === 0 && persistedTasks.length === 0) {
        return;
    }

    // Convert to comparable identities with early validation
    const registrationIdentities = registrations.map((registration, index) => {
        try {
            return registrationToTaskIdentity(registration);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new Error(`Invalid registration at index ${index}: ${error.message}`);
        }
    });
    
    const persistedIdentities = persistedTasks.map(taskRecordToTaskIdentity);

    // Use Set for faster lookup operations  
    const registrationNameSet = new Set(registrationIdentities.map(t => t.name));

    // Find mismatches efficiently
    const missing = [];
    const extra = [];
    const differing = [];

    // Find tasks in persisted state but not in registrations
    for (const persistedTask of persistedIdentities) {
        if (!registrationNameSet.has(persistedTask.name)) {
            missing.push(persistedTask.name);
        }
    }

    // Find tasks in registrations but not in persisted state, and check for differences
    const persistedMap = new Map(persistedIdentities.map(t => [t.name, t]));
    
    for (const regTask of registrationIdentities) {
        const persistedTask = persistedMap.get(regTask.name);
        
        if (!persistedTask) {
            extra.push(regTask.name);
        } else if (!taskIdentitiesEqual(regTask, persistedTask)) {
            // Detailed difference analysis
            if (regTask.cronExpression !== persistedTask.cronExpression) {
                differing.push({
                    name: regTask.name,
                    field: 'cronExpression',
                    expected: persistedTask.cronExpression,
                    actual: regTask.cronExpression
                });
            }
            if (regTask.retryDelayMs !== persistedTask.retryDelayMs) {
                differing.push({
                    name: regTask.name,
                    field: 'retryDelayMs',
                    expected: persistedTask.retryDelayMs,
                    actual: regTask.retryDelayMs
                });
            }
        }
    }

    // If any mismatches found, throw comprehensive error
    if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
        const mismatchDetails = { missing, extra, differing };
        let message = "Task list mismatch detected between registrations and persisted state:";

        if (missing.length > 0) {
            message += `\n  Missing tasks (in persisted state but not in registrations): ${missing.join(', ')}`;
            message += `\n    This suggests tasks were removed from the registration list without clearing persisted state.`;
        }
        if (extra.length > 0) {
            message += `\n  Extra tasks (in registrations but not in persisted state): ${extra.join(', ')}`;
            message += `\n    This suggests new tasks were added to the registration list.`;
        }
        if (differing.length > 0) {
            message += `\n  Modified tasks:`;
            for (const diff of differing) {
                message += `\n    ${diff.name}.${diff.field}: expected "${diff.expected}", got "${diff.actual}"`;
            }
            message += `\n    This suggests task configurations changed after initial registration.`;
        }

        message += `\n\nTo fix this mismatch, ensure the registration list exactly matches the previously persisted state,`;
        message += ` or clear the persisted state if intentional changes were made.`;

        throw new TaskListMismatchError(message, mismatchDetails);
    }
}

/**
 * Configuration options for scheduler initialization.
 * @typedef {object} PollerOptions
 * @property {number} [pollIntervalMs] - The polling interval in milliseconds (default varies by implementation)
 * @example
 * // Initialize with fast polling for testing
 * await scheduler.initialize(registrations, { pollIntervalMs: 100 });
 * 
 * // Initialize with slow polling for production
 * await scheduler.initialize(registrations, { pollIntervalMs: 60000 });
 */

/**
 * Initialize function that registers tasks with the scheduler.
 * @typedef {(registrations: Array<Registration>, options?: PollerOptions) => Promise<void>} Initialize
 * @example
 * // Basic initialization
 * await scheduler.initialize([
 *   ["task1", "0 * * * *", async () => { console.log("hourly"); }, fromMinutes(5)]
 * ]);
 * 
 * // With options
 * await scheduler.initialize(registrations, { pollIntervalMs: 30000 });
 */

/**
 * Stop function that gracefully shuts down the scheduler.
 * @typedef {() => Promise<void>} Stop
 * @example
 * // Graceful shutdown
 * await scheduler.stop();
 */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @param {() => Capabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {TaskListMismatchError} if registrations don't match persisted runtime state
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {ReturnType<cronScheduler.make> | null} */
    let pollingScheduler = null;
    
    /** @type {number | undefined} */
    let currentPollIntervalMs = undefined;

    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * Validates registration input format and content
     * @param {Registration[]} registrations
     * @throws {Error} if registrations are invalid
     */
    function validateRegistrations(registrations) {
        if (!Array.isArray(registrations)) {
            throw new Error("Registrations must be an array");
        }

        const seenNames = new Set();
        const capabilities = getCapabilitiesMemo();

        for (let i = 0; i < registrations.length; i++) {
            const registration = registrations[i];
            if (!Array.isArray(registration) || registration.length !== 4) {
                throw new Error(`Registration at index ${i} must be an array of length 4: [name, cronExpression, callback, retryDelay]`);
            }

            const [name, cronExpression, callback, retryDelay] = registration;
            
            if (typeof name !== 'string' || name.trim() === '') {
                throw new ScheduleInvalidNameError(name || '(empty)');
            }

            // Check for duplicate task names (but allow them for backwards compatibility)
            if (seenNames.has(name)) {
                // FIXME: make this a hard error, and test for it.
                capabilities.logger.logWarning({name, i, registrations}, `Duplicate task name '${name}' found at registration index ${i}. This may cause unpredictable behavior.`);
            }
            seenNames.add(name);

            // Validate name format (helpful for avoiding common mistakes)
            if (name.includes(' ')) {
                capabilities.logger.logWarning(
                    { name, index: i },
                    `Task name '${name}' contains spaces. Consider using hyphens or underscores instead.`
                );
            }

            if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
                throw new Error(`Registration at index ${i} (${name}): cronExpression must be a non-empty string, got: ${typeof cronExpression}`);
            }

            // Basic cron expression validation using the cron module
            if (!cronScheduler.validate(cronExpression)) {
                throw new Error(`Registration at index ${i} (${name}): invalid cron expression '${cronExpression}'`);
            }

            if (typeof callback !== 'function') {
                throw new Error(`Registration at index ${i} (${name}): callback must be a function, got: ${typeof callback}`);
            }

            if (!retryDelay || typeof retryDelay.toMilliseconds !== 'function') {
                throw new Error(`Registration at index ${i} (${name}): retryDelay must be a TimeDuration object with toMilliseconds() method`);
            }

            // Validate retry delay is reasonable (warn for very large delays but don't block)
            const retryMs = retryDelay.toMilliseconds();
            if (retryMs < 0) {
                throw new Error(`Registration at index ${i} (${name}): retryDelay cannot be negative`);
            }
            if (retryMs > 24 * 60 * 60 * 1000) { // 24 hours
                capabilities.logger.logWarning(
                    { name, retryDelayMs: retryMs, retryDelayHours: Math.round(retryMs / (60 * 60 * 1000)) },
                    `Task '${name}' has a very large retry delay of ${retryMs}ms (${Math.round(retryMs / (60 * 60 * 1000))} hours). Consider using a smaller delay.`
                );
            }
        }
    }

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations, options = {}) {
        // Validate input parameters
        validateRegistrations(registrations);
        
        if (options && typeof options !== 'object') {
            throw new Error("Options must be an object");
        }

        const requestedPollIntervalMs = options.pollIntervalMs;
        if (requestedPollIntervalMs !== undefined && (typeof requestedPollIntervalMs !== 'number' || requestedPollIntervalMs <= 0)) {
            throw new Error("pollIntervalMs must be a positive number");
        }

        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        async function getStorage(storage) {
            return await storage.getCurrentState();
        }

        const capabilities = getCapabilitiesMemo();
        const currentState = await transaction(capabilities, getStorage);
        const persistedTasks = currentState.tasks;

        // Always validate registrations against persisted state (unless first-time with empty state)
        if (persistedTasks.length === 0 && registrations.length > 0) {
            capabilities.logger.logInfo(
                { 
                    registeredTaskCount: registrations.length,
                    taskNames: registrations.map(([name]) => name)
                },
                "First-time scheduler initialization: registering initial tasks"
            );
        } else if (persistedTasks.length > 0 || registrations.length > 0) {
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

        // Handle polling scheduler lifecycle with interval change support
        if (pollingScheduler !== null) {
            // Check if polling interval needs to be changed
            if (requestedPollIntervalMs !== undefined && requestedPollIntervalMs !== currentPollIntervalMs) {
                capabilities.logger.logInfo(
                    { 
                        oldInterval: currentPollIntervalMs,
                        newInterval: requestedPollIntervalMs 
                    },
                    "Polling interval change requested: stopping current scheduler"
                );
                
                await pollingScheduler.stop();
                pollingScheduler = null;
                currentPollIntervalMs = undefined;
            } else {
                // Scheduler already running with correct interval
                capabilities.logger.logDebug(
                    { pollIntervalMs: currentPollIntervalMs },
                    "Scheduler already initialized with requested configuration"
                );
                return;
            }
        }

        // Create polling scheduler
        const cronOptions = {
            pollIntervalMs: requestedPollIntervalMs,
        };

        capabilities.logger.logInfo(
            { pollIntervalMs: requestedPollIntervalMs || "default" },
            "Creating new polling scheduler"
        );

        pollingScheduler = cronScheduler.make(capabilities, cronOptions);
        currentPollIntervalMs = requestedPollIntervalMs;

        let scheduledCount = 0;
        let skippedCount = 0;

        for (const [name, cronExpression, callback, retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name, cronExpression, callback, retryDelay);
                scheduledCount++;
                capabilities.logger.logDebug(
                    { 
                        taskName: name,
                        cronExpression,
                        retryDelayMs: retryDelay.toMilliseconds()
                    },
                    "Task scheduled successfully"
                );
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (cronScheduler.isScheduleDuplicateTaskError(error)) {
                    skippedCount++;
                    capabilities.logger.logDebug(
                        { taskName: name },
                        "Task already scheduled - scheduler already initialized"
                    );
                } else {
                    // Enhanced error context for debugging
                    const errorObj = error instanceof Error ? error : new Error(String(error));
                    capabilities.logger.logError(
                        { 
                            taskName: name,
                            cronExpression,
                            errorType: errorObj.constructor.name,
                            errorMessage: errorObj.message
                        },
                        "Failed to schedule task"
                    );
                    throw new Error(`Failed to schedule task '${name}': ${errorObj.message}`);
                }
            }
        }

        capabilities.logger.logInfo(
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
        if (pollingScheduler !== null) {
            const capabilities = getCapabilitiesMemo();
            try {
                capabilities.logger.logInfo(
                    { pollIntervalMs: currentPollIntervalMs },
                    "Stopping scheduler gracefully"
                );
                
                await pollingScheduler.stop();
                pollingScheduler = null;
                currentPollIntervalMs = undefined;
                
                capabilities.logger.logInfo({}, "Scheduler stopped successfully");
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                capabilities.logger.logError(
                    { 
                        errorType: error.constructor.name,
                        errorMessage: error.message
                    },
                    "Error occurred while stopping scheduler"
                );
                
                // Still clean up state even if stop failed
                pollingScheduler = null;
                currentPollIntervalMs = undefined;
                
                throw new Error(`Failed to stop scheduler: ${error.message}`);
            }
        } else {
            const capabilities = getCapabilitiesMemo();
            capabilities.logger.logDebug({}, "Scheduler already stopped or not initialized");
        }
    }

    return {
        initialize,
        stop,
    }
}

module.exports = {
    make,
    isTaskListMismatchError,
};
