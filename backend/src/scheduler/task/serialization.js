/**
 * Task serialization and deserialization functions.
 */

const { makeTask, getLastSuccessTime, getLastFailureTime, getLastAttemptTime, getPendingRetryUntil, getSchedulerIdentifier, createStateFromProperties } = require('./structure');
const { tryDeserialize: dateTimeTryDeserialize, isDateTimeTryDeserializeError } = require('../../datetime');
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
    
    // Extract values from state using helper functions and only include DateTime fields if they are defined
    const lastSuccessTime = getLastSuccessTime(task);
    const lastFailureTime = getLastFailureTime(task);
    const lastAttemptTime = getLastAttemptTime(task);
    const pendingRetryUntil = getPendingRetryUntil(task);
    const schedulerIdentifier = getSchedulerIdentifier(task);
    
    if (lastSuccessTime !== undefined) {
        serialized.lastSuccessTime = lastSuccessTime;
    }
    if (lastFailureTime !== undefined) {
        serialized.lastFailureTime = lastFailureTime;
    }
    if (lastAttemptTime !== undefined) {
        serialized.lastAttemptTime = lastAttemptTime;
    }
    if (pendingRetryUntil !== undefined) {
        serialized.pendingRetryUntil = pendingRetryUntil;
    }
    if (schedulerIdentifier !== undefined) {
        serialized.schedulerIdentifier = schedulerIdentifier;
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

        // Validate optional DateTime fields and deserialize them
        const dateTimeFields = [
            ["lastSuccessTime", "lastSuccessTime" in obj ? obj.lastSuccessTime : undefined],
            ["lastFailureTime", "lastFailureTime" in obj ? obj.lastFailureTime : undefined],
            ["lastAttemptTime", "lastAttemptTime" in obj ? obj.lastAttemptTime : undefined],
            ["pendingRetryUntil", "pendingRetryUntil" in obj ? obj.pendingRetryUntil : undefined],
        ];

        /** @type {Record<string, DateTime | undefined>} */
        const deserializedDateTimes = {};

        for (const [fieldName, value] of dateTimeFields) {
            if (value !== undefined) {
                if (value === null) {
                    return new TaskInvalidTypeError(String(fieldName), value, "DateTime or undefined (not null)");
                }
                
                const deserializeResult = dateTimeTryDeserialize(value);
                if (isDateTimeTryDeserializeError(deserializeResult)) {
                    return new TaskInvalidTypeError(
                        String(fieldName), 
                        value, 
                        "DateTime or undefined"
                    );
                }
                
                deserializedDateTimes[String(fieldName)] = deserializeResult;
            } else {
                deserializedDateTimes[String(fieldName)] = undefined;
            }
        }

        // Validate schedulerIdentifier field if present
        const schedulerIdentifier = ("schedulerIdentifier" in obj) ? obj.schedulerIdentifier : undefined;
        if (schedulerIdentifier !== undefined && typeof schedulerIdentifier !== "string") {
            return new TaskInvalidTypeError("schedulerIdentifier", schedulerIdentifier, "string or undefined");
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

        // Create state from individual properties using helper function
        const state = createStateFromProperties(
            deserializedDateTimes["lastSuccessTime"],
            deserializedDateTimes["lastFailureTime"],
            deserializedDateTimes["lastAttemptTime"],
            deserializedDateTimes["pendingRetryUntil"],
            schedulerIdentifier
        );

        // Create the task using the factory function with the new signature
        return makeTask(
            name,
            parsedCron,
            callback,
            retryDelay,
            state
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