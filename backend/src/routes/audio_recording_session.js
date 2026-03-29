const { makeRouter: makeAudioRecordingSessionRouter } = require('./audio_recording_session_routes');

/**
 * @param {import('./audio_recording_session_routes').Capabilities} capabilities
 */
function makeRouter(capabilities) {
    return makeAudioRecordingSessionRouter(capabilities);
}

module.exports = { makeRouter };
