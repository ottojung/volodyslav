// @ts-check
/**
 * Serialization utilities for scheduler state.
 */

/**
 * Deep clone an object.
 * @param {any} obj
 * @returns {any}
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (obj instanceof Date) {
        return new Date(obj);
    }

    if (Array.isArray(obj)) {
        return obj.map(deepClone);
    }

    const cloned = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            cloned[key] = deepClone(obj[key]);
        }
    }

    return cloned;
}

/**
 * Serialize scheduler state for persistence.
 * @param {import('../types').SchedulerState} state
 * @returns {object}
 */
function serialize(state) {
    return {
        version: state.version,
        tasks: state.tasks.map(serializeTask),
        lastUpdated: state.lastUpdated.epochMs,
    };
}

/**
 * Deserialize scheduler state from persistence.
 * @param {object} serialized
 * @returns {import('../types').SchedulerState}
 */
function deserialize(serialized) {
    const { fromEpochMs } = require('../value-objects/instant');
    const { validateState } = require('./schema');
    
    const state = {
        version: serialized.version,
        tasks: serialized.tasks.map(deserializeTask),
        lastUpdated: fromEpochMs(serialized.lastUpdated),
    };

    return validateState(state);
}

/**
 * Serialize a task.
 * @param {import('../types').TaskDefinition & import('../types').TaskRuntime} task
 * @returns {object}
 */
function serializeTask(task) {
    const { toString } = require('../value-objects/task-id');
    const { toJSON } = require('../value-objects/cron-expression/serialize');
    
    return {
        name: toString(task.name),
        cron: toJSON(task.cron),
        retryDelay: task.retryDelay.toMs(),
        lastSuccessTime: task.lastSuccessTime ? task.lastSuccessTime.epochMs : null,
        lastFailureTime: task.lastFailureTime ? task.lastFailureTime.epochMs : null,
        lastAttemptTime: task.lastAttemptTime ? task.lastAttemptTime.epochMs : null,
        pendingRetryUntil: task.pendingRetryUntil ? task.pendingRetryUntil.epochMs : null,
        lastEvaluatedFire: task.lastEvaluatedFire ? task.lastEvaluatedFire.epochMs : null,
        isRunning: task.isRunning,
    };
}

/**
 * Deserialize a task.
 * @param {object} serialized
 * @returns {import('../types').TaskDefinition & import('../types').TaskRuntime}
 */
function deserializeTask(serialized) {
    const { fromString } = require('../value-objects/task-id');
    const { fromString: cronFromString } = require('../value-objects/cron-expression');
    const { fromMs } = require('../value-objects/time-duration');
    const { fromEpochMs } = require('../value-objects/instant');
    
    return {
        name: fromString(serialized.name),
        cron: cronFromString(serialized.cron),
        retryDelay: fromMs(serialized.retryDelay),
        lastSuccessTime: serialized.lastSuccessTime ? fromEpochMs(serialized.lastSuccessTime) : null,
        lastFailureTime: serialized.lastFailureTime ? fromEpochMs(serialized.lastFailureTime) : null,
        lastAttemptTime: serialized.lastAttemptTime ? fromEpochMs(serialized.lastAttemptTime) : null,
        pendingRetryUntil: serialized.pendingRetryUntil ? fromEpochMs(serialized.pendingRetryUntil) : null,
        lastEvaluatedFire: serialized.lastEvaluatedFire ? fromEpochMs(serialized.lastEvaluatedFire) : null,
        isRunning: Boolean(serialized.isRunning),
    };
}

/**
 * Sort tasks deterministically for stable serialization.
 * @param {Array<import('../types').TaskDefinition & import('../types').TaskRuntime>} tasks
 * @returns {Array<import('../types').TaskDefinition & import('../types').TaskRuntime>}
 */
function sortTasks(tasks) {
    const { toString } = require('../value-objects/task-id');
    
    return [...tasks].sort((a, b) => {
        return toString(a.name).localeCompare(toString(b.name));
    });
}

module.exports = {
    deepClone,
    serialize,
    deserialize,
    serializeTask,
    deserializeTask,
    sortTasks,
};