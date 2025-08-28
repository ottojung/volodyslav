
/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../time_duration').TimeDuration} TimeDuration
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../types').Callback} Callback
 */

/**
 * Nominal type for Task to prevent external instantiation.
 */
class TaskClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {string} name
     * @param {CronExpression} parsedCron
     * @param {Callback} callback
     * @param {TimeDuration} retryDelay
     * @param {DateTime|undefined} lastSuccessTime
     * @param {DateTime|undefined} lastFailureTime
     * @param {DateTime|undefined} lastAttemptTime
     * @param {DateTime|undefined} pendingRetryUntil
     * @param {DateTime|undefined} lastEvaluatedFire
     */
    constructor(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, lastEvaluatedFire) {
        if (this.__brand !== undefined) {
            throw new Error("Task is a nominal type and cannot be instantiated directly. Use makeTask() instead.");
        }
        this.name = name;
        this.parsedCron = parsedCron;
        this.callback = callback;
        this.retryDelay = retryDelay;
        this.lastSuccessTime = lastSuccessTime;
        this.lastFailureTime = lastFailureTime;
        this.lastAttemptTime = lastAttemptTime;
        this.pendingRetryUntil = pendingRetryUntil;
        this.lastEvaluatedFire = lastEvaluatedFire;
    }
}

/**
 * Factory function to create a Task instance.
 * @param {string} name
 * @param {CronExpression} parsedCron
 * @param {Callback} callback
 * @param {TimeDuration} retryDelay
 * @param {DateTime|undefined} lastSuccessTime
 * @param {DateTime|undefined} lastFailureTime
 * @param {DateTime|undefined} lastAttemptTime
 * @param {DateTime|undefined} pendingRetryUntil
 * @param {DateTime|undefined} lastEvaluatedFire
 * @returns {TaskClass}
 */
function makeTask(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, lastEvaluatedFire) {
    return new TaskClass(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, lastEvaluatedFire);
}

/**
 * Type guard for Task instances.
 * @param {unknown} object
 * @returns {object is TaskClass}
 */
function isTask(object) {
    return object instanceof TaskClass;
}

/**
 * @typedef {TaskClass} Task
 */

module.exports = {
    makeTask,
    isTask,
};
