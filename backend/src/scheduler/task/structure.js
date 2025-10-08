
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
 * @property {DateTime} lastAttemptTime - Time of the last attempt (failure)
 * @property {DateTime} lastFailureTime - Time of the last failure
 * @property {DateTime} pendingRetryUntil - Time until which the task is pending retry
 */

/**
 * @typedef {object} AwaitingRun
 * @property {DateTime | null} lastSuccessTime - Time of the last successful run, or null if never run
 * @property {DateTime | null} lastAttemptTime - Time of the last attempt, or null if never attempted
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
 * Helper function to extract lastAttemptTime from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getLastAttemptTime(task) {
    if ('lastAttemptTime' in task.state) {
        return task.state.lastAttemptTime || undefined;
    }
    return undefined;
}

/**
 * Helper function to extract lastSuccessTime from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getLastSuccessTime(task) {
    if ('lastSuccessTime' in task.state) {
        return task.state.lastSuccessTime || undefined;
    }
    return undefined;
}

/**
 * Helper function to extract lastFailureTime from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getLastFailureTime(task) {
    if ('lastFailureTime' in task.state) {
        return task.state.lastFailureTime;
    }
    return undefined;
}

/**
 * Helper function to extract pendingRetryUntil from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getPendingRetryUntil(task) {
    if ('pendingRetryUntil' in task.state) {
        return task.state.pendingRetryUntil;
    }
    return undefined;
}

/**
 * Helper function to extract schedulerIdentifier from task state.
 * @param {Task} task
 * @returns {string | undefined}
 */
function getSchedulerIdentifier(task) {
    if ('schedulerIdentifier' in task.state) {
        return task.state.schedulerIdentifier;
    }
    return undefined;
}

/**
 * Helper function to create a state object from individual properties (for migration purposes).
 * @param {DateTime | undefined} lastSuccessTime
 * @param {DateTime | undefined} lastFailureTime
 * @param {DateTime | undefined} lastAttemptTime
 * @param {DateTime | undefined} pendingRetryUntil
 * @param {string | undefined} schedulerIdentifier
 * @returns {State}
 */
function createStateFromProperties(lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, schedulerIdentifier) {
    // Priority 1: If we have a pending retry, this is an AwaitingRetry state
    if (pendingRetryUntil && lastFailureTime) {
        /** @type {AwaitingRetry} */
        return {
            lastAttemptTime: lastAttemptTime ?? lastFailureTime,
            lastFailureTime,
            pendingRetryUntil
        };
    }
    
    // Priority 2: If we have lastAttemptTime and schedulerIdentifier (and no completion times), use Running
    if (lastAttemptTime && schedulerIdentifier && !lastSuccessTime && !lastFailureTime) {
        /** @type {Running} */
        return {
            lastAttemptTime,
            schedulerIdentifier
        };
    }
    
    // Default: AwaitingRun state
    /** @type {AwaitingRun} */
    return {
        lastSuccessTime: lastSuccessTime || null,
        lastAttemptTime: lastAttemptTime || null
    };
}

/**
 * @typedef {TaskClass} Task
 */

module.exports = {
    isTask,
    makeTask,
    getLastAttemptTime,
    getLastSuccessTime,
    getLastFailureTime,
    getPendingRetryUntil,
    getSchedulerIdentifier,
    createStateFromProperties,
};
