
const { isRunning } = require('./methods');
const { makeTask } = require('./structure');
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
 * @typedef {import('./serialization_errors').TaskTryDeserializeError} TaskTryDeserializeError
 */

module.exports = {
    isRunning,
    makeTask,
    serialize,
    tryDeserialize,
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
};
