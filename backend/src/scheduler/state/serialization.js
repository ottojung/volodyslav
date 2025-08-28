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

    /** @type {Record<string, any>} */
    const cloned = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
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
    
    // Validate serialized object structure
    if (!serialized || typeof serialized !== 'object') {
        throw new Error('Serialized state must be an object');
    }
    
    if (!('version' in serialized)) {
        throw new Error('Serialized state missing version');
    }
    
    if (!('tasks' in serialized) || !Array.isArray(serialized.tasks)) {
        throw new Error('Serialized state missing tasks array');
    }
    
    if (!('lastUpdated' in serialized)) {
        throw new Error('Serialized state missing lastUpdated');
    }
    
    // Cast to Record for safe access after validation
    const validSerialized = /** @type {Record<string, any>} */ (serialized);
    
    const state = {
        version: validSerialized['version'],
        tasks: validSerialized['tasks'].map(deserializeTask),
        lastUpdated: fromEpochMs(validSerialized['lastUpdated']),
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
    
    // Validate serialized task structure
    if (!serialized || typeof serialized !== 'object') {
        throw new Error('Serialized task must be an object');
    }
    
    if (!('name' in serialized)) {
        throw new Error('Serialized task missing name');
    }
    
    if (!('cron' in serialized)) {
        throw new Error('Serialized task missing cron');
    }
    
    if (!('retryDelay' in serialized)) {
        throw new Error('Serialized task missing retryDelay');
    }
    
    // Cast to Record for safe access after validation
    const validSerialized = /** @type {Record<string, any>} */ (serialized);
    
    return {
        name: fromString(validSerialized['name']),
        cron: cronFromString(validSerialized['cron']),
        retryDelay: fromMs(validSerialized['retryDelay']),
        lastSuccessTime: validSerialized['lastSuccessTime'] ? fromEpochMs(validSerialized['lastSuccessTime']) : null,
        lastFailureTime: validSerialized['lastFailureTime'] ? fromEpochMs(validSerialized['lastFailureTime']) : null,
        lastAttemptTime: validSerialized['lastAttemptTime'] ? fromEpochMs(validSerialized['lastAttemptTime']) : null,
        pendingRetryUntil: validSerialized['pendingRetryUntil'] ? fromEpochMs(validSerialized['pendingRetryUntil']) : null,
        lastEvaluatedFire: validSerialized['lastEvaluatedFire'] ? fromEpochMs(validSerialized['lastEvaluatedFire']) : null,
        isRunning: Boolean(validSerialized['isRunning']),
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