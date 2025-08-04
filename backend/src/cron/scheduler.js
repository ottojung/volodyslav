/**
 * Custom cron scheduler implementation.
 * Provides task scheduling functionality with cron expressions.
 */

const { parseCronExpression, getNextExecution } = require("./parser");
const { generateTaskId, isTaskId } = require("./task_id");
const { SchedulerError } = require("./scheduler_errors");
const datetime = require("../datetime");

/** @typedef {import('./task_id').TaskIdClass} TaskId */

/**
 * Represents a scheduled task.
 */
class ScheduledTaskClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {TaskId} id
     * @param {string} cronExpression
     * @param {() => Promise<void> | void} callback
     * @param {NodeJS.Timeout} timeout
     * @param {import('../datetime').DateTime} nextExecution
     */
    constructor(id, cronExpression, callback, timeout, nextExecution) {
        if (this.__brand !== undefined) {
            throw new Error("ScheduledTask is a nominal type");
        }
        this.id = id;
        this.cronExpression = cronExpression;
        this.callback = callback;
        this.timeout = timeout;
        this.nextExecution = nextExecution;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduledTaskClass}
 */
function isScheduledTask(object) {
    return object instanceof ScheduledTaskClass;
}

/**
 * Custom cron scheduler class.
 */
class CronSchedulerClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("CronScheduler is a nominal type");
        }
        /** @type {Map<string, ScheduledTaskClass>} */
        this.tasks = new Map();
        this.taskCounter = 0;
        this.datetime = datetime.make();
    }

    /**
     * Schedules a task with the given cron expression.
     * @param {string} cronExpression - The cron expression
     * @param {() => Promise<void> | void} callback - The callback function to execute
     * @returns {TaskId} Task ID that can be used to cancel the task
     * @throws {SchedulerError} If the cron expression is invalid
     */
    schedule(cronExpression, callback) {
        try {
            const parsedCron = parseCronExpression(cronExpression);
            const taskId = generateTaskId(++this.taskCounter);
            
            this._scheduleTask(taskId, cronExpression, parsedCron, callback);
            return taskId;
        } catch (error) {
            throw new SchedulerError(
                `Failed to schedule task: ${error instanceof Error ? error.message : String(error)}`,
                cronExpression
            );
        }
    }

    /**
     * Cancels a scheduled task.
     * @param {TaskId} taskId - The task ID to cancel
     * @returns {boolean} True if the task was found and cancelled, false otherwise
     */
    cancel(taskId) {
        if (!isTaskId(taskId)) {
            return false;
        }
        
        const task = this.tasks.get(taskId.toString());
        if (!task) {
            return false;
        }

        clearTimeout(task.timeout);
        this.tasks.delete(taskId.toString());
        return true;
    }

    /**
     * Cancels all scheduled tasks.
     * @returns {number} Number of tasks that were cancelled
     */
    cancelAll() {
        const count = this.tasks.size;
        for (const task of this.tasks.values()) {
            clearTimeout(task.timeout);
        }
        this.tasks.clear();
        return count;
    }

    /**
     * Gets information about all scheduled tasks.
     * @returns {Array<{id: TaskId, cronExpression: string, nextExecution: import('../datetime').DateTime}>}
     */
    getTasks() {
        return Array.from(this.tasks.values()).map(task => ({
            id: task.id,
            cronExpression: task.cronExpression,
            nextExecution: task.nextExecution
        }));
    }

    /**
     * Internal method to schedule a task.
     * @private
     * @param {TaskId} taskId
     * @param {string} cronExpression
     * @param {import('./expression').CronExpressionClass} parsedCron
     * @param {() => Promise<void> | void} callback
     */
    _scheduleTask(taskId, cronExpression, parsedCron, callback) {
        const now = this.datetime.now();
        const nextExecution = getNextExecution(parsedCron, now);
        const delay = this.datetime.toEpochMs(nextExecution) - this.datetime.toEpochMs(now);

        const timeout = setTimeout(() => {
            this._executeTask(taskId, cronExpression, parsedCron, callback);
        }, delay);

        const task = new ScheduledTaskClass(
            taskId,
            cronExpression,
            callback,
            timeout,
            nextExecution
        );

        this.tasks.set(taskId.toString(), task);
    }

    /**
     * Internal method to execute a task and reschedule it.
     * @private
     * @param {TaskId} taskId
     * @param {string} cronExpression
     * @param {import('./expression').CronExpressionClass} parsedCron
     * @param {() => Promise<void> | void} callback
     */
    async _executeTask(taskId, cronExpression, parsedCron, callback) {
        try {
            // Execute the callback
            const result = callback();
            if (result instanceof Promise) {
                await result;
            }
        } catch (error) {
            // Log error but don't stop the scheduler
            console.error(`Error executing scheduled task ${taskId.toString()}:`, error);
        }

        // Reschedule the task for the next execution
        if (this.tasks.has(taskId.toString())) {
            this._scheduleTask(taskId, cronExpression, parsedCron, callback);
        }
    }
}

/**
 * @param {unknown} object
 * @returns {object is CronSchedulerClass}
 */
function isCronScheduler(object) {
    return object instanceof CronSchedulerClass;
}

/**
 * Factory function to create a new cron scheduler.
 * @returns {CronSchedulerClass}
 */
function makeCronScheduler() {
    return new CronSchedulerClass();
}

module.exports = {
    makeCronScheduler,
    isCronScheduler,
    isScheduledTask,
};
