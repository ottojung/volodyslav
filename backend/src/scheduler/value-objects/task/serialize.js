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
    
    // After validation, we know these properties exist
    const validRecord = /** @type {Record<string, any>} */ (record);
    
    const name = fromString(validRecord['name']);
    const cron = cronFromString(validRecord['cronExpression']);
    const retryDelay = fromMs(validRecord['retryDelayMs']);
    
    const lastSuccessTime = validRecord['lastSuccessTime'] ? fromEpochMs(validRecord['lastSuccessTime']) : null;
    const lastFailureTime = validRecord['lastFailureTime'] ? fromEpochMs(validRecord['lastFailureTime']) : null;
    const lastAttemptTime = validRecord['lastAttemptTime'] ? fromEpochMs(validRecord['lastAttemptTime']) : null;
    const pendingRetryUntil = validRecord['pendingRetryUntil'] ? fromEpochMs(validRecord['pendingRetryUntil']) : null;
    const lastEvaluatedFire = validRecord['lastEvaluatedFire'] ? fromEpochMs(validRecord['lastEvaluatedFire']) : null;
    
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