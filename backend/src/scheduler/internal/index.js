/**
 * Scheduling module index - exports internal scheduling components.
 * These are internal implementation details for the polling scheduler.
 */

const { findPreviousFire, getMostRecentExecution } = require("./previous_fire_calculator");
const { calculateMinimumCronInterval, validateTaskFrequency } = require("./frequency_validator");
const { mutateTasks } = require("./state_persistence");
const { makeTaskExecutor } = require("./task_executor");

module.exports = {
    findPreviousFire,
    getMostRecentExecution,
    calculateMinimumCronInterval,
    validateTaskFrequency,
    mutateTasks,
    makeTaskExecutor,
};
