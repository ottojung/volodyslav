/**
 * State validation for comparing registrations against persisted state.
 * Ensures consistency between runtime registrations and stored scheduler state.
 */

const {
    TaskListMismatchError,
    InvalidRegistrationError,
} = require('../new_errors');

/**
 * Task identity operations for comparing registrations and persisted state.
 */

/**
 * Converts a registration to a TaskIdentity for comparison.
 * @param {import('../new_types/task_types').Registration} registration
 * @returns {import('../new_types/scheduler_types').TaskIdentity}
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
 * Converts a persisted TaskRecord to a TaskIdentity for comparison.
 * @param {import('../../runtime_state_storage/types').TaskRecord} taskRecord
 * @returns {import('../new_types/scheduler_types').TaskIdentity}
 */
function taskRecordToTaskIdentity(taskRecord) {
    return {
        name: taskRecord.name,
        cronExpression: taskRecord.cronExpression,
        retryDelayMs: taskRecord.retryDelayMs,
    };
}

/**
 * Compares two TaskIdentity objects for equality.
 * @param {import('../new_types/scheduler_types').TaskIdentity} a
 * @param {import('../new_types/scheduler_types').TaskIdentity} b
 * @returns {boolean}
 */
function taskIdentitiesEqual(a, b) {
    return (a.name === b.name &&
        a.cronExpression === b.cronExpression &&
        a.retryDelayMs === b.retryDelayMs);
}

/**
 * Validates that registrations match persisted runtime state.
 * @param {import('../new_types/task_types').Registration[]} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @returns {void}
 * @throws {TaskListMismatchError} if tasks don't match
 */
function validateTasksAgainstPersistedState(registrations, persistedTasks) {
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
            throw new InvalidRegistrationError(
                `Invalid registration at index ${index}: ${error.message}`, 
                { index, cause: error }
            );
        }
    });

    const persistedIdentities = persistedTasks.map(taskRecordToTaskIdentity);

    // Use Set for faster lookup operations  
    const persistedMap = new Map(persistedIdentities.map(id => [id.name, id]));
    const registrationMap = new Map(registrationIdentities.map(id => [id.name, id]));

    // Find mismatches
    const missing = [];
    const extra = [];
    const differing = [];

    // Check for missing tasks (in persisted but not in registrations)
    for (const persistedTask of persistedIdentities) {
        if (!registrationMap.has(persistedTask.name)) {
            missing.push(persistedTask.name);
        }
    }

    // Check for extra tasks and differing tasks
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

    // Throw error if any mismatches found
    if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
        const details = { missing, extra, differing };
        let message = "Task list mismatch detected between registrations and persisted state.";
        
        if (missing.length > 0) {
            message += ` Missing tasks: ${missing.join(', ')}.`;
        }
        if (extra.length > 0) {
            message += ` Extra tasks: ${extra.join(', ')}.`;
        }
        if (differing.length > 0) {
            const differingNames = differing.map(d => `${d.name}(${d.field})`).join(', ');
            message += ` Differing tasks: ${differingNames}.`;
        }

        throw new TaskListMismatchError(message, details);
    }
}

module.exports = {
    validateTasksAgainstPersistedState,
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
};