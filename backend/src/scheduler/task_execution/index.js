/**
 * Task execution module.
 * Encapsulates all functionality related to evaluating and executing tasks.
 */

const { evaluateTasksForExecution, TaskNotFoundError } = require("./evaluation");

module.exports = {
    evaluateTasksForExecution,
    TaskNotFoundError,
};