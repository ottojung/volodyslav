/**
 * Individual event module.
 * Provides the event lookup computor for individual events.
 */

const { computeEventForId, isEventNotFoundError } = require("./compute");

module.exports = {
    computeEventForId,
    isEventNotFoundError,
};
