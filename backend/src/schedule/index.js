/**
 * Declarative scheduler that exposes only a single initialization entrypoint.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 */

const cronScheduler = require("../cron");
const { transaction } = require("../runtime_state_storage");

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
 * Registration tuple: [name, cronExpression, callback, retryDelay]
 * @typedef {[string, string, () => Promise<void>, TimeDuration]} Registration
 */

/**
 * Task identity for comparison
 * @typedef {object} TaskIdentity
 * @property {string} name - Task name
 * @property {string} cronExpression - Cron expression
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
    return a.name === b.name && 
           a.cronExpression === b.cronExpression && 
           a.retryDelayMs === b.retryDelayMs;
}

/**
 * Validates that registrations match persisted runtime state (inner implementation)
 * @param {Registration[]} registrations
 * @param {import('../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @returns {void}
 * @throws {TaskListMismatchError} if tasks don't match
 */
function validateTasksAgainstPersistedStateInner(registrations, persistedTasks) {
    // Convert to comparable identities
    const registrationIdentities = registrations.map(registrationToTaskIdentity);
    const persistedIdentities = persistedTasks.map(taskRecordToTaskIdentity);
    
    // Sort by name for deterministic comparison
    registrationIdentities.sort((a, b) => a.name.localeCompare(b.name));
    persistedIdentities.sort((a, b) => a.name.localeCompare(b.name));
    
    // Find mismatches
    const registrationMap = new Map(registrationIdentities.map(t => [t.name, t]));
    const persistedMap = new Map(persistedIdentities.map(t => [t.name, t]));
    
    const missing = [];
    const extra = [];
    const differing = [];
    
    // Find tasks in persisted state but not in registrations
    for (const persistedTask of persistedIdentities) {
        if (!registrationMap.has(persistedTask.name)) {
            missing.push(persistedTask.name);
        }
    }
    
    // Find tasks in registrations but not in persisted state
    for (const regTask of registrationIdentities) {
        if (!persistedMap.has(regTask.name)) {
            extra.push(regTask.name);
        }
    }
    
    // Find tasks with differing properties
    for (const regTask of registrationIdentities) {
        const persistedTask = persistedMap.get(regTask.name);
        if (persistedTask && !taskIdentitiesEqual(regTask, persistedTask)) {
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
    
    // If any mismatches found, throw error
    if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
        const mismatchDetails = { missing, extra, differing };
        let message = "Task list mismatch detected:";
        
        if (missing.length > 0) {
            message += `\n  Missing tasks (in persisted state but not in registrations): ${missing.join(', ')}`;
        }
        if (extra.length > 0) {
            message += `\n  Extra tasks (in registrations but not in persisted state): ${extra.join(', ')}`;
        }
        if (differing.length > 0) {
            message += `\n  Differing tasks:`;
            for (const diff of differing) {
                message += `\n    ${diff.name}.${diff.field}: expected ${diff.expected}, got ${diff.actual}`;
            }
        }
        
        throw new TaskListMismatchError(message, mismatchDetails);
    }
}

/**
 * Initialize the scheduler with the given registrations.
 * This function is idempotent - calling it multiple times has no additional effect.
 * 
 * @param {Capabilities} capabilities - The capabilities object
 * @param {Registration[]} registrations - Array of [name, cronExpression, callback, retryDelay] tuples
 * @param {{pollIntervalMs?: number}} [options] - Optional configuration for the underlying scheduler
 * @returns {Promise<void>} - Resolves when initialization and validation complete
 * @throws {TaskListMismatchError} if registrations don't match persisted runtime state
 */
async function initialize(capabilities, registrations, options = {}) {
    await transaction(capabilities, async (storage) => {
        const currentState = await storage.getCurrentState();
        const persistedTasks = currentState.tasks;
        
        // Always validate registrations against persisted state (unless first-time with empty state)
        if (persistedTasks.length === 0 && registrations.length > 0) {
            capabilities.logger.logInfo(
                { registeredTaskCount: registrations.length }, 
                "First-time scheduler initialization: registering initial tasks"
            );
        } else {
            // Validate registrations match persisted state
            validateTasksAgainstPersistedStateInner(registrations, persistedTasks);
        }
        
        // Create polling scheduler
        const cronOptions = {
            pollIntervalMs: options.pollIntervalMs,
        };
        const pollingScheduler = cronScheduler.make(capabilities, cronOptions);
        
        // Schedule all tasks - the cron scheduler will handle idempotency naturally
        // If a task is already scheduled, it will either update it (if loaded from persistence)
        // or throw ScheduleDuplicateTaskError (if already actively scheduled)
        for (const [name, cronExpression, callback, retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name, cronExpression, callback, retryDelay);
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (cronScheduler.isScheduleDuplicateTaskError(error)) {
                    capabilities.logger.logDebug(
                        { taskName: name },
                        "Task already scheduled - scheduler already initialized"
                    );
                } else {
                    // Re-throw any other errors
                    throw error;
                }
            }
        }
        
        // Store scheduler instance for testing access
        // @ts-expect-error - Adding _testScheduler property for testing purposes
        capabilities._testScheduler = pollingScheduler;
    });
}

/**
 * Get the scheduler instance for testing purposes only.
 * This should only be used in tests.
 * 
 * @param {Capabilities} capabilities - The capabilities object that was used for initialization
 * @returns {object} The scheduler instance with testing methods
 */
function getSchedulerForTesting(capabilities) {
    // @ts-expect-error - Accessing _testScheduler property for testing purposes
    if (!capabilities._testScheduler) {
        throw new Error("getSchedulerForTesting can only be used after initialize() has been called with test capabilities");
    }
    
    // @ts-expect-error - Accessing _testScheduler property for testing purposes
    return capabilities._testScheduler;
}

module.exports = {
    initialize,
    getSchedulerForTesting,
    TaskListMismatchError,
    isTaskListMismatchError,
};

