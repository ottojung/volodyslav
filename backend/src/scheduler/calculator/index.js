/**
 * Mathematical cron calculator exports.
 * Provides the same API as the previous implementation while using
 * the new O(1) field-based algorithms internally.
 */

const { matchesCronExpression } = require("./current");
const { getNextExecution } = require("./next");
const { findPreviousFire, getMostRecentExecution } = require("./previous");

module.exports = {
    matchesCronExpression,
    getNextExecution,
    findPreviousFire,
    getMostRecentExecution,
};