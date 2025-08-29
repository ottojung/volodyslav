/**
 * Core state validation logic.
 */

const {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
} = require("../task/identity");
const { TaskListMismatchError } = require("./errors");

/** @typedef {import('../types').Registration} Registration */

/**
 * Error for invalid registration input (used in state validation context).
 */
class InvalidRegistrationError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "InvalidRegistrationError";
        this.details = details;
    }
}

/**
 * Validates that registrations match persisted runtime state (inner implementation)
 * @param {Registration[]} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTasks
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
            throw new InvalidRegistrationError(`Invalid registration at index ${index}: ${error.message}`, { index, cause: error });
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

module.exports = {
    validateTasksAgainstPersistedStateInner,
};