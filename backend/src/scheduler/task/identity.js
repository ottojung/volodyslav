/**
 * Task identity operations for comparing registrations and persisted state.
 */

/** @typedef {import('../types').Registration} Registration */
/** @typedef {import('../types').TaskIdentity} TaskIdentity */

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
 * @param {import('../../runtime_state_storage/types').TaskRecord} taskRecord
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
    return (a.name === b.name &&
        a.cronExpression === b.cronExpression &&
        a.retryDelayMs === b.retryDelayMs);
}

module.exports = {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
};
