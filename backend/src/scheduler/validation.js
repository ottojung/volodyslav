/**
 * Validation logic for scheduler registrations and task state.
 */

const { parseCronExpression } = require("./expression");
const {
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    TaskListMismatchError,
    isTaskListMismatchError,
    RegistrationsNotArrayError,
    RegistrationShapeError,
    InvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    CallbackTypeError,
    RetryDelayTypeError,
    NegativeRetryDelayError,
} = require("./errors");

const {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
} = require("./task_identity");

/** @typedef {import('./types').Registration} Registration */

/**
 * Validates that the tasks provided to initialize() match the persisted runtime state.
 * @param {Registration[]} registrations
 * @param {import('../runtime_state_storage/types').TaskRecord[]} persistedTasks
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

/**
 * Validates registration input format and content
 * @param {Registration[]} registrations
 * @param {import('./types').Capabilities} capabilities
 * @throws {Error} if registrations are invalid
 */
function validateRegistrations(registrations, capabilities) {
    if (!Array.isArray(registrations)) {
        throw new RegistrationsNotArrayError("Registrations must be an array");
    }

    const seenNames = new Set();

    for (let i = 0; i < registrations.length; i++) {
        const registration = registrations[i];
        if (!Array.isArray(registration) || registration.length !== 4) {
            throw new RegistrationShapeError(`Registration at index ${i} must be an array of length 4: [name, cronExpression, callback, retryDelay]`, { index: i, registration });
        }

        const [name, cronExpression, callback, retryDelay] = registration;

        if (typeof name !== 'string' || name.trim() === '') {
            throw new ScheduleInvalidNameError(name || '(empty)');
        }

        const qname = JSON.stringify(name);

        // Check for duplicate task names - this is now a hard error
        if (seenNames.has(name)) {
            throw new ScheduleDuplicateTaskError(name);
        }
        seenNames.add(name);

        // Validate name format (helpful for avoiding common mistakes)
        if (name.includes(' ')) {
            capabilities.logger.logWarning(
                { name, index: i },
                `Task name ${qname} contains spaces. Consider using hyphens or underscores instead.`
            );
        }

        if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
            throw new InvalidCronExpressionTypeError(`Registration at index ${i} (${qname}): cronExpression must be a non-empty string, got: ${typeof cronExpression}`, { index: i, name, value: cronExpression });
        }

        // Basic cron expression validation using the cron module
        try {
            parseCronExpression(cronExpression);
        } catch (error) {
            throw new CronExpressionInvalidError(`Registration at index ${i} (${qname}): invalid cron expression '${cronExpression}'`, { index: i, name, value: cronExpression });
        }

        if (typeof callback !== 'function') {
            throw new CallbackTypeError(`Registration at index ${i} (${qname}): callback must be a function, got: ${typeof callback}`, { index: i, name, value: callback });
        }

        if (!retryDelay || typeof retryDelay.toMilliseconds !== 'function') {
            throw new RetryDelayTypeError(`Registration at index ${i} (${qname}): retryDelay must be a TimeDuration object with toMilliseconds() method`, { index: i, name, value: retryDelay });
        }

        // Validate retry delay is reasonable (warn for very large delays but don't block)
        const retryMs = retryDelay.toMilliseconds();
        if (retryMs < 0) {
            throw new NegativeRetryDelayError(`Registration at index ${i} (${qname}): retryDelay cannot be negative`, { index: i, name, retryMs });
        }
        if (retryMs > 24 * 60 * 60 * 1000) { // 24 hours
            capabilities.logger.logWarning(
                { name, retryDelayMs: retryMs, retryDelayHours: Math.round(retryMs / (60 * 60 * 1000)) },
                `Task ${qname} has a very large retry delay of ${retryMs}ms (${Math.round(retryMs / (60 * 60 * 1000))} hours). Consider using a smaller delay.`
            );
        }
    }
}

module.exports = {
    validateTasksAgainstPersistedStateInner,
    validateRegistrations,
    isTaskListMismatchError,
    isScheduleDuplicateTaskError,
};