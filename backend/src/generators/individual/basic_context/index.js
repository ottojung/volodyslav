/**
 * Individual basic_context module.
 * Provides the basic context lookup computor for individual events.
 */

const {
    computeBasicContextForEventId,
} = require("./compute");
const { computor } = require("./wrapper");

module.exports = {
    computeBasicContextForEventId,
    computor,
};
