/**
 * Core state validation logic.
 */

const task = require("../task");
const {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
} = task.identity;
const registrationValidation = require("../registration_validation");
const { InvalidRegistrationError } = registrationValidation.errors;

/** @typedef {import('../types').Registration} Registration */


/**
 * Compares registrations with persisted state and logs any differences.
 * Unlike validateTasksAgainstPersistedStateInner, this function does not throw errors
 * but instead logs the changes and indicates that registrations should override persisted state.
 * @param {Registration[]} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @returns {{shouldOverride: boolean, changeDetails: {missing: string[], extra: string[], differing: Array<{name: string, field: string, expected: any, actual: any}>}}}
 */
function analyzeStateChanges(registrations, persistedTasks, capabilities) {
    // Early exit optimization for empty arrays
    if (registrations.length === 0 && persistedTasks.length === 0) {
        return { shouldOverride: false, changeDetails: { missing: [], extra: [], differing: [] } };
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

    const changeDetails = { missing, extra, differing };
    const shouldOverride = missing.length > 0 || extra.length > 0 || differing.length > 0;

    // Log the changes that will be made
    if (shouldOverride) {
        capabilities.logger.logInfo(
            {
                removedTasks: missing,
                addedTasks: extra,
                modifiedTasks: differing.map(d => ({ name: d.name, field: d.field, from: d.expected, to: d.actual })),
                totalChanges: missing.length + extra.length + differing.length
            },
            "Scheduler state override: registrations differ from persisted state, applying changes"
        );

        if (missing.length > 0) {
            capabilities.logger.logDebug(
                { taskNames: missing },
                "Removing tasks from persisted state (no longer in registrations)"
            );
        }
        if (extra.length > 0) {
            capabilities.logger.logDebug(
                { taskNames: extra },
                "Adding new tasks to persisted state"
            );
        }
        if (differing.length > 0) {
            capabilities.logger.logDebug(
                { modifications: differing },
                "Updating task configurations in persisted state"
            );
        }
    }

    return { shouldOverride, changeDetails };
}

module.exports = {
    analyzeStateChanges,
};