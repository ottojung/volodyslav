/**
 * Audio recording session module.
 *
 * Re-exports the public API for audio recording session management.
 * @module audio_recording_session
 */

const service = require("./service");
const errors = require("./errors");

module.exports = {
    ...service,
    ...errors,
};
