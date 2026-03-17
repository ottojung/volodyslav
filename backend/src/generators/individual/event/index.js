/**
 * Individual event module.
 * Provides the event lookup computor for individual events.
 */

const {
    computeEventForId,
    getSerializedEventForIdOrThrow,
    isEventNotFoundError,
} = require("./compute");
const { computor } = require("./wrapper");

module.exports = {
    computeEventForId,
    getSerializedEventForIdOrThrow,
    isEventNotFoundError,
    computor,
};
