/**
 * Computes the list of audio file paths associated with a given event.
 *
 * Scans the event's assets directory on disk and returns the relative paths
 * (relative to the event-log assets root) of every file whose name matches
 * the known audio extensions or the hard-coded "diary-audio.webm" name.
 *
 * This node exists so that the diary summary pipeline — and any other consumer
 * — can discover an event's audio files through the incremental graph rather
 * than directly touching the filesystem themselves.
 */

const path = require("path");
const { fromISOString } = require("../../../datetime");

/** @typedef {import('../../incremental_graph/database/types').EventAudiosListEntry} EventAudiosListEntry */
/** @typedef {import('../../incremental_graph/database/types').EventEntry} EventEntry */

/**
 * @typedef {object} EventAudiosListCapabilities
 * @property {import('../../../environment').Environment} environment
 * @property {import('../../../filesystem/checker').FileChecker} checker
 * @property {import('../../../filesystem/dirscanner').DirScanner} scanner
 * @property {import('../../../logger').Logger} logger
 */

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"]);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFilename(filename) {
    const basename = path.basename(filename).toLowerCase();
    if (basename === "diary-audio.webm") {
        return true;
    }
    return AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/**
 * Computes the list of relative audio file paths for an event.
 *
 * @param {EventAudiosListCapabilities} capabilities
 * @param {import('../../../event').SerializedEvent} serializedEvent
 * @returns {Promise<EventAudiosListEntry>}
 */
async function computeEventAudiosList(capabilities, serializedEvent) {
    const assetsRoot = capabilities.environment.eventLogAssetsDirectory();
    const eventId = serializedEvent.id;

    // Reconstruct the event's asset directory from the serialized event's date string.
    // Use the project's fromISOString to parse the date consistently.
    // serializedEvent.date is always a string (SerializedEvent stores dates as ISO strings).
    const parsedDate = fromISOString(serializedEvent.date);
    const year = parsedDate.year;
    const month = String(parsedDate.month).padStart(2, "0");
    const day = String(parsedDate.day).padStart(2, "0");

    const dirPath = path.join(assetsRoot, `${year}-${month}`, day, eventId);

    capabilities.logger.logDebug(
        { eventId, dirPath },
        "event_audios_list: scanning event assets directory",
    );

    const dirProof = await capabilities.checker.directoryExists(dirPath);
    if (dirProof === null) {
        capabilities.logger.logDebug(
            { eventId, dirPath },
            "event_audios_list: no assets directory found, returning empty list",
        );
        return { type: "event_audios_list", event: serializedEvent, audioPaths: [] };
    }

    let files;
    try {
        files = await capabilities.scanner.scanDirectory(dirPath);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError(
            { eventId, dirPath, error, errorMessage },
            "event_audios_list: failed to scan event assets directory",
        );
        return { type: "event_audios_list", event: serializedEvent, audioPaths: [] };
    }

    const audioPaths = files
        .filter((file) => isAudioFilename(path.basename(file.path)))
        .map((file) => path.relative(assetsRoot, file.path))
        .sort();

    capabilities.logger.logDebug(
        { eventId, audioPaths },
        "event_audios_list: found audio files",
    );

    return { type: "event_audios_list", event: serializedEvent, audioPaths };

// Note: the serialized event is embedded in the entry (rather than just its ID) so that
// the event_transcription(e, a) computor — whose inputs are [event_audios_list(e),
// transcription(a)] — can reconstruct the full Event for path-association validation
// without needing a separate event(e) input.
}

module.exports = {
    computeEventAudiosList,
    isAudioFilename,
};
