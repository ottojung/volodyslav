/**
 * Individual event module.
 * Provides the event lookup computor for individual events.
 */

const { computeEventForId, EventNotFoundError, isEventNotFoundError } = require("./compute");

module.exports = {
    computeEventForId,
    EventNotFoundError,
    isEventNotFoundError,
};
