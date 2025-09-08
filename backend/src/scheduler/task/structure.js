
/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../datetime').Duration} Duration
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
     * @param {Duration} retryDelay
     * @param {DateTime|undefined} lastSuccessTime
     * @param {DateTime|undefined} lastFailureTime
     * @param {DateTime|undefined} lastAttemptTime
     * @param {DateTime|undefined} pendingRetryUntil
     * @param {string|undefined} schedulerIdentifier
     */
    constructor(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, schedulerIdentifier) {
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
        this.schedulerIdentifier = schedulerIdentifier;
    }
}

/**
 * Factory function to create a Task instance.
 * @param {string} name
 * @param {CronExpression} parsedCron
 * @param {Callback} callback
 * @param {Duration} retryDelay
 * @param {DateTime|undefined} lastSuccessTime
 * @param {DateTime|undefined} lastFailureTime
 * @param {DateTime|undefined} lastAttemptTime
 * @param {DateTime|undefined} pendingRetryUntil
 * @param {string|undefined} schedulerIdentifier
 * @returns {TaskClass}
 */
function makeTask(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, schedulerIdentifier) {
    return new TaskClass(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, schedulerIdentifier);
}

/**
 * @typedef {TaskClass} Task
 */

module.exports = {
    makeTask,
};
