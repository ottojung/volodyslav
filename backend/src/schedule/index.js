/**
 * Declarative scheduler that exposes only a single initialization entrypoint.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 */

const cronScheduler = require("../cron");
const { transaction } = require("../runtime_state_storage");
const { TaskListMismatchError, MultipleInitializationsError, isTaskListMismatchError, isMultipleInitializationsError } = require("../user_errors");

/** @typedef {import('../time_duration/structure').TimeDuration} TimeDuration */
/** @typedef {import('./tasks').Capabilities} Capabilities */

// Module-level state to track initialization
let isInitialized = false;
let pollingScheduler = null;

/**
 * Reset the module state (for testing purposes only)
 * @private
 */
function resetState() {
    isInitialized = false;
    pollingScheduler = null;
}

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
 * Validates that registrations match persisted runtime state
 * @param {Capabilities} capabilities
 * @param {Registration[]} registrations
 * @returns {Promise<void>}
 * @throws {TaskListMismatchError} if tasks don't match
 */
async function validateTasksAgainstPersistedState(capabilities, registrations) {
    await transaction(capabilities, async (storage) => {
        const currentState = await storage.getCurrentState();
        const persistedTasks = currentState.tasks;
        
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
    });
}

/**
 * Initialize the scheduler with the given registrations.
 * This function is idempotent - calling it multiple times has no additional effect.
 * 
 * @param {Capabilities} capabilities - The capabilities object
 * @param {Registration[]} registrations - Array of [name, cronExpression, callback, retryDelay] tuples
 * @returns {Promise<void>} - Resolves when initialization and validation complete
 * @throws {TaskListMismatchError} if registrations don't match persisted runtime state
 */
async function initialize(capabilities, registrations) {
    // Idempotent behavior - do nothing if already initialized
    if (isInitialized) {
        return;
    }
    
    // Validate against persisted state
    await validateTasksAgainstPersistedState(capabilities, registrations);
    
    // Create polling scheduler
    pollingScheduler = cronScheduler.make(capabilities);
    
    // Schedule all tasks
    for (const [name, cronExpression, callback, retryDelay] of registrations) {
        await pollingScheduler.schedule(name, cronExpression, callback, retryDelay);
    }
    
    // Mark as initialized
    isInitialized = true;
}

module.exports = {
    initialize,
    TaskListMismatchError,
    MultipleInitializationsError,
    isTaskListMismatchError,
    isMultipleInitializationsError,
    // For testing only
    _resetState: resetState,
};

