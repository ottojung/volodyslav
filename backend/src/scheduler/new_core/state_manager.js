/**
 * State management for scheduler tasks.
 * Handles persistence and loading of task state to/from disk.
 */

const { makeDefault } = require('../../runtime_state_storage/structure');
const { TaskNotInRegistrationsError } = require('../new_errors');

// Task structure and serialization - simplified consolidated version
/** @typedef {import('../../datetime').DateTime} DateTime */
/** @typedef {import('../new_types/task_types').Callback} Callback */
/** @typedef {import('../new_types/task_types').CronExpression} CronExpression */
/** @typedef {import('../new_types/task_types').TimeDuration} TimeDuration */
/** @typedef {import('../new_types/task_types').ParsedRegistrations} ParsedRegistrations */

/**
 * Task data structure representing scheduled task state.
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

/** @typedef {TaskClass} Task */

/**
 * Factory function to create a Task instance.
 * @param {string} name
 * @param {CronExpression} parsedCron
 * @param {Callback} callback
 * @param {TimeDuration} retryDelay
 * @param {DateTime|undefined} [lastSuccessTime]
 * @param {DateTime|undefined} [lastFailureTime]
 * @param {DateTime|undefined} [lastAttemptTime]
 * @param {DateTime|undefined} [pendingRetryUntil]
 * @param {DateTime|undefined} [lastEvaluatedFire]
 * @returns {Task}
 */
function makeTask(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, lastEvaluatedFire) {
    return new TaskClass(name, parsedCron, callback, retryDelay, lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, lastEvaluatedFire);
}

/**
 * Type guard for Task instances.
 * @param {unknown} object
 * @returns {object is Task}
 */
function isTask(object) {
    return object instanceof TaskClass;
}

/**
 * Check if a task is currently running.
 * @param {Task} task
 * @returns {boolean}
 */
function isRunning(task) {
    if (task.lastAttemptTime === undefined) {
        return false;
    }

    // A task is running if the last attempt is more recent than any completion
    const lastAttemptMs = task.lastAttemptTime.getTime();
    
    const lastSuccessMs = task.lastSuccessTime ? task.lastSuccessTime.getTime() : -1;
    const lastFailureMs = task.lastFailureTime ? task.lastFailureTime.getTime() : -1;
    const lastCompletionMs = Math.max(lastSuccessMs, lastFailureMs);
    
    return lastAttemptMs > lastCompletionMs;
}

/**
 * Serialize a task to a storable record.
 * @param {Task} task
 * @returns {import('../../runtime_state_storage/types').TaskRecord}
 */
function serializeTask(task) {
    return {
        name: task.name,
        cronExpression: task.parsedCron.original,
        retryDelayMs: task.retryDelay.toMilliseconds(),
        lastSuccessTime: task.lastSuccessTime,
        lastFailureTime: task.lastFailureTime,
        lastAttemptTime: task.lastAttemptTime,
        pendingRetryUntil: task.pendingRetryUntil,
        lastEvaluatedFire: task.lastEvaluatedFire,
    };
}

/**
 * Materialize task records into Task objects.
 * @param {ParsedRegistrations} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} taskRecords
 * @returns {Map<string, Task>}
 */
function materializeTasks(registrations, taskRecords) {
    const tasks = new Map();

    // Create a map of existing task records by name for lookup
    const recordMap = new Map(taskRecords.map(record => [record.name, record]));

    // For each registration, create or restore a task
    for (const registration of registrations.values()) {
        const existingRecord = recordMap.get(registration.name);
        
        if (existingRecord) {
            // Restore task from persisted state
            const task = makeTask(
                registration.name,
                registration.parsedCron,
                registration.callback,
                registration.retryDelay,
                existingRecord.lastSuccessTime,
                existingRecord.lastFailureTime,
                existingRecord.lastAttemptTime,
                existingRecord.pendingRetryUntil,
                existingRecord.lastEvaluatedFire
            );
            tasks.set(registration.name, task);
        } else {
            // Create new task
            const task = makeTask(
                registration.name,
                registration.parsedCron,
                registration.callback,
                registration.retryDelay
            );
            tasks.set(registration.name, task);
        }
    }

    // Check for orphaned tasks (in persisted state but not in registrations)
    for (const record of taskRecords) {
        if (!registrations.has(record.name)) {
            throw new TaskNotInRegistrationsError(record.name);
        }
    }

    return tasks;
}

/**
 * Function that operates on a collection of tasks and returns a result.
 * @template T
 * @typedef {(tasks: Map<string, Task>) => T} Transformation
 */

/**
 * Execute a transformation on tasks with state persistence.
 * @template T
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation) {
    return await capabilities.state.transaction(async (storage) => {
        async function getCurrentState() {
            const existingState = await storage.getExistingState();
            if (existingState === null) {
                const ret = makeDefault(capabilities.datetime);

                for (const registration of registrations.values()) {
                    ret.tasks.push({
                        name: registration.name,
                        cronExpression: registration.parsedCron.original,
                        retryDelayMs: registration.retryDelay.toMilliseconds(),
                    });
                }

                return ret;
            } else {
                return existingState;
            }
        }

        const currentState = await getCurrentState();
        const currentTaskRecords = currentState.tasks;
        const tasks = materializeTasks(registrations, currentTaskRecords);
        const result = transformation(tasks);

        // Convert tasks to serializable format
        const taskRecords = Array.from(tasks.values()).map(serializeTask);

        // Update state with new task records
        const newState = {
            ...currentState,
            tasks: taskRecords,
        };

        storage.setState(newState);

        capabilities.logger.logDebug({ taskCount: tasks.size }, "State persisted");
        return result;
    });
}

module.exports = {
    makeTask,
    isTask,
    isRunning,
    serializeTask,
    materializeTasks,
    mutateTasks,
};