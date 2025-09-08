/**
 * Task serialization and deserialization functions.
 */

const { makeTask } = require('./structure');
const { isDateTime } = require('../../datetime');
const {
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    TaskInvalidStructureError,
} = require('./serialization_errors');

/**
 * @typedef {import('./structure').Task} Task
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('luxon').Duration} Duration
 * @typedef {import('../types').Callback} Callback
 * @typedef {import('./serialization_errors').TaskTryDeserializeError} TaskTryDeserializeError
 */

/**
 * @typedef SerializedTask
 * @type {Object}
 * @property {string} name - Task name
 * @property {string} cronExpression - Original cron expression 
 * @property {number} retryDelayMs - Retry delay in milliseconds
 * @property {DateTime} [lastSuccessTime] - Last successful execution time
 * @property {DateTime} [lastFailureTime] - Last failed execution time
 * @property {DateTime} [lastAttemptTime] - Last attempt time
 * @property {DateTime} [pendingRetryUntil] - Pending retry until time
 * @property {string} [schedulerIdentifier] - Identifier of the scheduler instance that started this task
 */

/**
 * Serialize a Task to a plain object.
 * @param {Task} task - The task to serialize
 * @returns {SerializedTask} - The serialized task
 */
function serialize(task) {
    /** @type {SerializedTask} */
    const serialized = {
        name: task.name,
        cronExpression: task.parsedCron.original,
        retryDelayMs: task.retryDelay.toMillis(),
    };
    
    // Only include DateTime fields if they are defined
    if (task.lastSuccessTime !== undefined) {
        serialized.lastSuccessTime = task.lastSuccessTime;
    }
    if (task.lastFailureTime !== undefined) {
        serialized.lastFailureTime = task.lastFailureTime;
    }
    if (task.lastAttemptTime !== undefined) {
        serialized.lastAttemptTime = task.lastAttemptTime;
    }
    if (task.pendingRetryUntil !== undefined) {
        serialized.pendingRetryUntil = task.pendingRetryUntil;
    }
    if (task.schedulerIdentifier !== undefined) {
        serialized.schedulerIdentifier = task.schedulerIdentifier;
    }
    return serialized;
}

/**
 * Attempt to deserialize an unknown object into a Task.
 * This requires access to registrations to get the parsed cron expression and callback.
 * Returns the Task on success, or a TaskTryDeserializeError on failure.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @param {import('../types').ParsedRegistrations} registrations - The task registrations
 * @returns {Task | TaskTryDeserializeError} - The deserialized Task or error object
 */
function tryDeserialize(obj, registrations) {
    try {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return new TaskInvalidStructureError(
                "Object must be a non-null object and not an array",
                obj
            );
        }

        // Validate name field
        if (!("name" in obj)) return new TaskMissingFieldError("name");
        const name = obj.name;
        if (typeof name !== "string") {
            return new TaskInvalidTypeError("name", name, "string");
        }

        // Validate cronExpression field
        if (!("cronExpression" in obj)) return new TaskMissingFieldError("cronExpression");
        const cronExpression = obj.cronExpression;
        if (typeof cronExpression !== "string") {
            return new TaskInvalidTypeError("cronExpression", cronExpression, "string");
        }

        // Validate retryDelayMs field
        if (!("retryDelayMs" in obj)) return new TaskMissingFieldError("retryDelayMs");
        const retryDelayMs = obj.retryDelayMs;
        if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
            return new TaskInvalidTypeError("retryDelayMs", retryDelayMs, "non-negative number");
        }
        if (!Number.isInteger(retryDelayMs)) {
            return new TaskInvalidTypeError("retryDelayMs", retryDelayMs, "integer");
        }

        // Validate optional DateTime fields
        const lastSuccessTime = ("lastSuccessTime" in obj) ? obj.lastSuccessTime : undefined;
        const lastFailureTime = ("lastFailureTime" in obj) ? obj.lastFailureTime : undefined;
        const lastAttemptTime = ("lastAttemptTime" in obj) ? obj.lastAttemptTime : undefined;
        const pendingRetryUntil = ("pendingRetryUntil" in obj) ? obj.pendingRetryUntil : undefined;
        const schedulerIdentifier = ("schedulerIdentifier" in obj) ? obj.schedulerIdentifier : undefined;

        // Validate schedulerIdentifier field if present
        if (schedulerIdentifier !== undefined && typeof schedulerIdentifier !== "string") {
            return new TaskInvalidTypeError("schedulerIdentifier", schedulerIdentifier, "string or undefined");
        }

        // Validate DateTime fields
        for (const [fieldName, value] of [
            ["lastSuccessTime", lastSuccessTime],
            ["lastFailureTime", lastFailureTime],
            ["lastAttemptTime", lastAttemptTime],
            ["pendingRetryUntil", pendingRetryUntil],
        ]) {
            if (value !== undefined) {
                if (value === null) {
                    return new TaskInvalidTypeError(String(fieldName), value, "DateTime or undefined (not null)");
                }
                if (!isDateTime(value)) {
                    return new TaskInvalidTypeError(String(fieldName), value, "DateTime or undefined");
                }
            }
        }

        // Look up the registration to get parsed cron and callback
        const registration = registrations.get(name);
        if (registration === undefined) {
            return new TaskInvalidValueError(
                "name",
                name,
                "task not found in registrations"
            );
        }

        const { parsedCron, callback, retryDelay } = registration;

        // Verify that the serialized cron expression matches the registration
        if (cronExpression !== parsedCron.original) {
            return new TaskInvalidValueError(
                "cronExpression",
                cronExpression,
                `does not match registration cron expression: ${parsedCron.original}`
            );
        }

        // Verify that the retry delay matches
        if (retryDelayMs !== retryDelay.toMillis()) {
            return new TaskInvalidValueError(
                "retryDelayMs",
                retryDelayMs,
                `does not match registration retry delay: ${retryDelay.toMillis()}`
            );
        }

        // Create the task using the factory function
        return makeTask(
            name,
            parsedCron,
            callback,
            retryDelay,
            /** @type {DateTime|undefined} */ (lastSuccessTime),
            /** @type {DateTime|undefined} */ (lastFailureTime),
            /** @type {DateTime|undefined} */ (lastAttemptTime),
            /** @type {DateTime|undefined} */ (pendingRetryUntil),
            /** @type {string|undefined} */ (schedulerIdentifier),
        );

    } catch (error) {
        return new TaskInvalidValueError(
            "unknown",
            obj,
            `Unexpected error during deserialization: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

module.exports = {
    serialize,
    tryDeserialize,
};