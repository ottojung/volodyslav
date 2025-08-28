/**
 * State validation logic for comparing registrations with persisted state.
 */

const { TaskListMismatchError } = require("../errors");
const {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
} = require("../task_identity");

/** @typedef {import('../types').Registration} Registration */

/**
 * Validates that the tasks provided to initialize() match the persisted runtime state.
 * @param {Registration[]} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @throws {TaskListMismatchError} if registrations don't match persisted state
 */
function validateTasksAgainstPersistedStateInner(registrations, persistedTasks) {
    // Convert to common format for comparison
    const currentIdentities = registrations.map(registrationToTaskIdentity);
    const persistedIdentities = persistedTasks.map(taskRecordToTaskIdentity);

    // Find mismatches
    const missing = [];
    const extra = [];
    const differing = [];

    // Check for missing tasks (in persisted but not in current)
    for (const persistedIdentity of persistedIdentities) {
        const found = currentIdentities.find(current => current.name === persistedIdentity.name);
        if (!found) {
            missing.push(persistedIdentity.name);
        } else if (!taskIdentitiesEqual(found, persistedIdentity)) {
            // Task exists but properties differ
            const differences = [];
            if (found.cronExpression !== persistedIdentity.cronExpression) {
                differences.push({
                    name: found.name,
                    field: 'cronExpression',
                    expected: persistedIdentity.cronExpression,
                    actual: found.cronExpression
                });
            }
            if (found.retryDelayMs !== persistedIdentity.retryDelayMs) {
                differences.push({
                    name: found.name,
                    field: 'retryDelayMs',
                    expected: persistedIdentity.retryDelayMs,
                    actual: found.retryDelayMs
                });
            }
            differing.push(...differences);
        }
    }

    // Check for extra tasks (in current but not in persisted)
    for (const currentIdentity of currentIdentities) {
        const found = persistedIdentities.find(persisted => persisted.name === currentIdentity.name);
        if (!found) {
            extra.push(currentIdentity.name);
        }
    }

    // If there are any mismatches, throw detailed error
    if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
        const details = { missing, extra, differing };
        let message = "Task list mismatch detected:";
        
        if (missing.length > 0) {
            message += `\n  Missing tasks: ${missing.join(', ')}`;
        }
        if (extra.length > 0) {
            message += `\n  Extra tasks: ${extra.join(', ')}`;
        }
        if (differing.length > 0) {
            message += `\n  Modified tasks: ${differing.map(d => `${d.name}.${d.field}`).join(', ')}`;
        }
        
        message += "\nEnsure task registrations exactly match the persisted state or clear the state storage.";
        
        throw new TaskListMismatchError(message, details);
    }
}

module.exports = {
    validateTasksAgainstPersistedStateInner,
};