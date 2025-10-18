/**
 * Task execution module.
 * Encapsulates all functionality related to evaluating and executing tasks.
 */

const { evaluateTasksForExecution, calculateNextDueTime } = require("./collector");
const { makeTaskExecutor } = require("./executor");

module.exports = {
    makeTaskExecutor,
    evaluateTasksForExecution,
    calculateNextDueTime,
};
