// @ts-check
/**
 * @typedef {TaskClass} Task
 */

/**
 * @typedef {import('../../types').Callback} Callback
 */

/**
 * Task definition and runtime state (nominal type).
 */
class TaskClass {
    /** @type {import('../task-id').TaskId} */
    name;
    
    /** @type {import('../cron-expression').CronExpression} */
    cron;
    
    /** @type {Callback} */
    callback;
    
    /** @type {import('../time-duration').TimeDuration} */
    retryDelay;
    
    /** @type {import('../instant').InstantMs | null} */
    lastSuccessTime;
    
    /** @type {import('../instant').InstantMs | null} */
    lastFailureTime;
    
    /** @type {import('../instant').InstantMs | null} */
    lastAttemptTime;
    
    /** @type {import('../instant').InstantMs | null} */
    pendingRetryUntil;
    
    /** @type {import('../instant').InstantMs | null} */
    lastEvaluatedFire;
    
    /** @type {boolean} */
    isRunning;

    /**
     * Creates a new Task instance.
     * @param {import('../task-id').TaskId} name
     * @param {import('../cron-expression').CronExpression} cron
     * @param {Callback} callback
     * @param {import('../time-duration').TimeDuration} retryDelay
     * @param {import('../instant').InstantMs | null} lastSuccessTime
     * @param {import('../instant').InstantMs | null} lastFailureTime
     * @param {import('../instant').InstantMs | null} lastAttemptTime
     * @param {import('../instant').InstantMs | null} pendingRetryUntil
     * @param {import('../instant').InstantMs | null} lastEvaluatedFire
     * @param {boolean} isRunning
     */
    constructor(name, cron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, lastEvaluatedFire, isRunning) {
        this.name = name;
        this.cron = cron;
        this.callback = callback;
        this.retryDelay = retryDelay;
        this.lastSuccessTime = lastSuccessTime;
        this.lastFailureTime = lastFailureTime;
        this.lastAttemptTime = lastAttemptTime;
        this.pendingRetryUntil = pendingRetryUntil;
        this.lastEvaluatedFire = lastEvaluatedFire;
        this.isRunning = isRunning;
    }

    /**
     * Mark task as running.
     */
    markRunning() {
        this.isRunning = true;
    }

    /**
     * Mark task as not running.
     */
    markNotRunning() {
        this.isRunning = false;
    }

    /**
     * Update last attempt time.
     * @param {import('../instant').InstantMs} time
     */
    setLastAttemptTime(time) {
        this.lastAttemptTime = time;
    }

    /**
     * Update last success time and clear retry state.
     * @param {import('../instant').InstantMs} time
     */
    setLastSuccessTime(time) {
        this.lastSuccessTime = time;
        this.pendingRetryUntil = null;
    }

    /**
     * Update last failure time and set retry state.
     * @param {import('../instant').InstantMs} time
     * @param {import('../instant').InstantMs} retryUntil
     */
    setLastFailureTime(time, retryUntil) {
        this.lastFailureTime = time;
        this.pendingRetryUntil = retryUntil;
    }
}

/**
 * Create a new Task instance.
 * @param {import('../task-id').TaskId} name
 * @param {import('../cron-expression').CronExpression} cron
 * @param {Callback} callback
 * @param {import('../time-duration').TimeDuration} retryDelay
 * @param {import('../instant').InstantMs | null} lastSuccessTime
 * @param {import('../instant').InstantMs | null} lastFailureTime
 * @param {import('../instant').InstantMs | null} lastAttemptTime
 * @param {import('../instant').InstantMs | null} pendingRetryUntil
 * @param {import('../instant').InstantMs | null} lastEvaluatedFire
 * @param {boolean} isRunning
 * @returns {Task}
 */
function createTask(name, cron, callback, retryDelay, lastSuccessTime = null, lastFailureTime = null, lastAttemptTime = null, pendingRetryUntil = null, lastEvaluatedFire = null, isRunning = false) {
    return new TaskClass(
        name, cron, callback, retryDelay, 
        lastSuccessTime, lastFailureTime, lastAttemptTime, 
        pendingRetryUntil, lastEvaluatedFire, isRunning
    );
}

/**
 * Type guard for Task.
 * @param {any} object
 * @returns {object is Task}
 */
function isTask(object) {
    return object instanceof TaskClass;
}

module.exports = {
    createTask,
    isTask,
    TaskClass, // Export class for internal use
};