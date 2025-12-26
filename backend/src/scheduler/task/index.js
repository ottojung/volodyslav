
const { isRunning } = require('./methods');
const { makeTask, isTask, getPendingRetryUntil } = require('./structure');
const { serialize, tryDeserialize } = require('./serialization');
const {
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
} = require('./serialization_errors');

/**
 * @typedef {import('./structure').Task} Task
 */

/**
 * @typedef {import('./structure').Running} Running
 * @typedef {import('./structure').AwaitingRetry} AwaitingRetry
 * @typedef {import('./structure').AwaitingRun} AwaitingRun
 */

/**
 * @typedef {import('./serialization').TaskTryDeserializeError} TaskTryDeserializeError
 */

/**
 * @typedef {import('./serialization').SerializedTask} SerializedTask
 */

module.exports = {
    isRunning,
    makeTask,
    isTask,
    getPendingRetryUntil,
    serialize,
    tryDeserialize,
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
};
