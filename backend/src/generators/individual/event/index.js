/**
 * Individual event module.
 * Provides the event lookup computor for individual events.
 */

const { computeEventForId, isEventNotFoundError } = require("./compute");
const { computor } = require("./wrapper");

module.exports = {
    computeEventForId,
    isEventNotFoundError,
    computor,
};
