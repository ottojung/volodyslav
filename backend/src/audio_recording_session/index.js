/**
 * Audio recording session module.
 *
 * Re-exports the public API for audio recording session management.
 * @module audio_recording_session
 */

const service = require("./service");
const errors = require("./errors");
const helpers = require("./helpers");

module.exports = {
    ...service,
    ...errors,
    MAX_FRAGMENT_COUNT: helpers.MAX_FRAGMENT_COUNT,
};
