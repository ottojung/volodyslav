
const { isRunning } = require('./methods');
const { makeTask, isTask } = require('./structure');

/**
 * @typedef {import('./structure').Task} Task
 */

module.exports = {
    isRunning,
    makeTask,
    isTask,
};
