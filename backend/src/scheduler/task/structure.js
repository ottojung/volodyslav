
/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../datetime').Duration} Duration
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../types').Callback} Callback
 */


/**
 * @typedef {object} Running
 * @property {DateTime} lastAttemptTime - Time of the last attempt
 * @property {string} schedulerIdentifier - Identifier of the scheduler that started this task
 */

/**
 * @typedef {object} AwaitingRetry
 * @property {DateTime} lastFailureTime - Time of the last failure
 * @property {DateTime} pendingRetryUntil - Time until which the task is pending retry
 */

/**
 * @typedef {object} AwaitingRun
 * @property {DateTime | null} lastSuccessTime - Time of the last successful run, or null if never run
 */

/**
 * @typedef {Running | AwaitingRetry | AwaitingRun } State
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
     * @param {State} state
     */
    constructor(name, parsedCron, callback, retryDelay, state) {
        if (this.__brand !== undefined) {
            throw new Error("Task is a nominal type and cannot be instantiated directly. Use makeTask() instead.");
        }
        this.name = name;
        this.parsedCron = parsedCron;
        this.callback = callback;
        this.retryDelay = retryDelay;
        this.state = state;
    }
}

/**
 * Factory function to create a Task instance.
 * @param {string} name
 * @param {CronExpression} parsedCron
 * @param {Callback} callback
 * @param {Duration} retryDelay
 * @param {State} state
 * @returns {TaskClass}
 */
function makeTask(name, parsedCron, callback, retryDelay, state) {
    return new TaskClass(name, parsedCron, callback, retryDelay, state);
}

/**
 * @param {unknown} value 
 * @returns {value is TaskClass}
 */
function isTask(value) {
    return value instanceof TaskClass;
}

/**
 * @typedef {TaskClass} Task
 */

module.exports = {
    isTask,
    makeTask,
};
