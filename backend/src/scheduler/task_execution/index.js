/**
 * Task execution module.
 * Encapsulates all functionality related to evaluating and executing tasks.
 */

const { evaluateTasksForExecution, TaskEvaluationNotFoundError } = require("./evaluation");

module.exports = {
    evaluateTasksForExecution,
    TaskEvaluationNotFoundError,
};