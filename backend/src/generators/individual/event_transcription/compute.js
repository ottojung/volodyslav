const path = require("path");

/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../incremental_graph/database/types').TranscriptionResult} TranscriptionResult */

/**
 * @typedef {object} ComputedEventTranscription
 * @property {'event_transcription'} type
 * @property {Event} event
 * @property {TranscriptionResult} transcription
 */

class AudioNotAssociatedWithEventError extends Error {
    /**
     * @param {string} audioPath
     * @param {string} eventId
     */
    constructor(audioPath, eventId) {
        super(`Audio path ${audioPath} is not associated with event ${eventId}`);
        this.name = "AudioNotAssociatedWithEventError";
        this.audioPath = audioPath;
        this.eventId = eventId;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AudioNotAssociatedWithEventError}
 */
function isAudioNotAssociatedWithEventError(object) {
    return object instanceof AudioNotAssociatedWithEventError;
}

/**
 * Computes the asset directory suffix for an event.
 * The canonical layout is: `<YYYY-MM>/<DD>/<event id>`
 *
 * @param {Event} event
 * @returns {string}
 */
function getEventAssetDirectorySuffix(event) {
    const month = event.date.month.toString().padStart(2, "0");
    const day = event.date.day.toString().padStart(2, "0");
    return path.join(
        `${event.date.year}-${month}`,
        day,
        event.id.identifier,
    );
}

/**
 * @typedef {Object} TranscriptionCapabilities
 * @property {import('../../../logger').Logger} logger
 */

/**
 * Combines an event and its transcription after validating that the audio path
 * belongs to the event.
 *
 * @param {TranscriptionCapabilities} capabilities
 * @param {Event} event
 * @param {TranscriptionResult} transcription
 * @param {string} audioPath - Audio path relative to the assets root
 * @returns {ComputedEventTranscription}
 */
function computeEventTranscription(capabilities, event, transcription, audioPath) {
    // Normalize both sides to forward-slash separators so that the check is
    // consistent with the canonical `<YYYY-MM>/<DD>/<event id>/<filename>`
    // layout documented in the spec, regardless of the host OS path separator.
    const suffix = getEventAssetDirectorySuffix(event).replace(/\\/g, "/");
    const normalizedAudioPath = audioPath.replace(/\\/g, "/");
    const expectedPrefix = suffix + "/";

    capabilities.logger.logDebug(
        {
            event_id: event.id.identifier,
            audio_path: audioPath,
            expected_prefix: expectedPrefix,
        },
        "Validating audio path association with event",
    );

    if (!normalizedAudioPath.startsWith(expectedPrefix)) {
        throw new AudioNotAssociatedWithEventError(audioPath, event.id.identifier);
    }
    return { type: "event_transcription", event, transcription };
}

module.exports = {
    computeEventTranscription,
    isAudioNotAssociatedWithEventError,
};
