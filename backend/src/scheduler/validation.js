/**
 * Validation logic for scheduler registrations and task state.
 */

const { parseCronExpression } = require("./expression/parser");

/**
 * Error thrown when attempting to register a task with a name that already exists.
 */
class ScheduleDuplicateTaskError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task with name "${taskName}" is already scheduled`);
        this.name = "ScheduleDuplicateTaskError";
        this.taskName = taskName;
    }
}

/**
 * Error thrown when an invalid task name is provided.
 */
class ScheduleInvalidNameError extends Error {
    /**
     * @param {unknown} taskName
     */
    constructor(taskName) {
        super("Task name must be a non-empty string");
        this.name = "ScheduleInvalidNameError";
        this.taskName = /** @type {string} */ (taskName);
    }
}

const {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
} = require("./task_identity");

/** @typedef {import('./types').Registration} Registration */

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

/**
 * Error for invalid registration input.
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
 * Error when registrations is not an array.
 */
class RegistrationsNotArrayError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "RegistrationsNotArrayError";
    }
}

/**
 * Error for invalid registration shape.
 */
class RegistrationShapeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "RegistrationShapeError";
        this.details = details;
    }
}

/**
 * Error for invalid cron expression type.
 */
class InvalidCronExpressionTypeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "InvalidCronExpressionTypeError";
        this.details = details;
    }
}

/**
 * Error for invalid cron expression.
 */
class CronExpressionInvalidError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "CronExpressionInvalidError";
        this.details = details;
    }
}

/**
 * Error for invalid callback type.
 */
class CallbackTypeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "CallbackTypeError";
        this.details = details;
    }
}

/**
 * Error for invalid retry delay type.
 */
class RetryDelayTypeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "RetryDelayTypeError";
        this.details = details;
    }
}

/**
 * Error for negative retry delay.
 */
class NegativeRetryDelayError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "NegativeRetryDelayError";
        this.details = details;
    }
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
};