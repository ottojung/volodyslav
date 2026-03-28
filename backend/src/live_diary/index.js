/**
 * Live diary questioning module.
 *
 * Re-exports the public API for the server-side live diary pipeline.
 * @module live_diary
 */

const { pushAudio, getPendingQuestions } = require("./service");

module.exports = {
    pushAudio,
    getPendingQuestions,
};
