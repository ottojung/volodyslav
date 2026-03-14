/**
 * Individual calories module.
 * Provides the calorie estimation computor for individual events.
 */

const { computeCaloriesForEvent } = require("./compute");
const { makeComputor } = require("./wrapper");

module.exports = {
    computeCaloriesForEvent,
    makeComputor,
};
