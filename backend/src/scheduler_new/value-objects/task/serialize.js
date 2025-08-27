// @ts-check

/**
 * Serialize and deserialize Task objects.
 */

/**
 * Serialize a Task to a persistable record.
 * @param {import('./index').Task} task
 * @returns {object}
 */
function serialize(task) {
    const { toString } = require('../task-id');
    const { toJSON } = require('../cron-expression/serialize');
    const { toJSON: durationToJSON } = require('../time-duration/serialize');
    
    return {
        name: toString(task.name),
        cronExpression: toJSON(task.cron),
        retryDelayMs: task.retryDelay.toMs(),
        lastSuccessTime: task.lastSuccessTime ? task.lastSuccessTime.epochMs : null,
        lastFailureTime: task.lastFailureTime ? task.lastFailureTime.epochMs : null,
        lastAttemptTime: task.lastAttemptTime ? task.lastAttemptTime.epochMs : null,
        pendingRetryUntil: task.pendingRetryUntil ? task.pendingRetryUntil.epochMs : null,
        lastEvaluatedFire: task.lastEvaluatedFire ? task.lastEvaluatedFire.epochMs : null,
    };
}

/**
 * Deserialize a Task from a persistable record.
 * @param {object} record - Serialized task record
 * @param {import('../../types').Callback} callback - Task callback function
 * @returns {import('./index').Task}
 */
function deserialize(record, callback) {
    const { fromString } = require('../task-id');
    const { fromString: cronFromString } = require('../cron-expression');
    const { fromMs } = require('../time-duration');
    const { fromEpochMs } = require('../instant');
    const { createTask } = require('./index');
    
    if (!record || typeof record !== 'object') {
        throw new Error("Task record must be an object");
    }
    
    const requiredFields = ['name', 'cronExpression', 'retryDelayMs'];
    for (const field of requiredFields) {
        if (!(field in record)) {
            throw new Error(`Missing required field: ${field}`);
        }
    }
    
    const name = fromString(record.name);
    const cron = cronFromString(record.cronExpression);
    const retryDelay = fromMs(record.retryDelayMs);
    
    const lastSuccessTime = record.lastSuccessTime ? fromEpochMs(record.lastSuccessTime) : null;
    const lastFailureTime = record.lastFailureTime ? fromEpochMs(record.lastFailureTime) : null;
    const lastAttemptTime = record.lastAttemptTime ? fromEpochMs(record.lastAttemptTime) : null;
    const pendingRetryUntil = record.pendingRetryUntil ? fromEpochMs(record.pendingRetryUntil) : null;
    const lastEvaluatedFire = record.lastEvaluatedFire ? fromEpochMs(record.lastEvaluatedFire) : null;
    
    return createTask(
        name, cron, callback, retryDelay,
        lastSuccessTime, lastFailureTime, lastAttemptTime,
        pendingRetryUntil, lastEvaluatedFire, false
    );
}

module.exports = {
    serialize,
    deserialize,
};