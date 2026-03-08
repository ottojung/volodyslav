const path = require("path");
const { fromISOString } = require("../../../datetime");

/** @typedef {import('../../incremental_graph/database/types').EventTranscriptionEntry} EventTranscriptionEntry */
/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../../transcribe').Transcription} Transcription */

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
 * @param {unknown} candidate
 * @returns {candidate is { year: number, month: number, day: number }}
 */
function hasDateParts(candidate) {
    return candidate !== null &&
        typeof candidate === "object" &&
        "year" in candidate &&
        "month" in candidate &&
        "day" in candidate &&
        typeof candidate.year === "number" &&
        typeof candidate.month === "number" &&
        typeof candidate.day === "number";
}

/**
 * @param {string} iso
 * @returns {{ year: number, month: number, day: number }}
 */
function parseIsoDateParts(iso) {
    const parsed = fromISOString(iso);
    return {
        year: parsed.year,
        month: parsed.month,
        day: parsed.day,
    };
}

/**
 * @param {unknown} candidate
 * @returns {candidate is Record<string, unknown>}
 */
function isObject(candidate) {
    return candidate !== null && typeof candidate === "object";
}

/**
 * @param {unknown} date
 * @returns {{ year: number, month: number, day: number } | null}
 */
function tryParseIsoDateParts(date) {
    if (typeof date === "string") {
        return parseIsoDateParts(date);
    }
    if (isObject(date) && "toISOString" in date && typeof date["toISOString"] === "function") {
        try {
            return parseIsoDateParts(date["toISOString"]());
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * @param {unknown} date
 * @returns {{ year: number, month: number, day: number } | null}
 */
function tryParseDirectDateParts(date) {
    if (hasDateParts(date)) {
        return date;
    }
    return null;
}

/**
 * Luxon sometimes persists the raw date components under `c`.
 * This is an internal Luxon structure rather than part of a stable public API,
 * so this fallback exists only to keep cached graph values readable across the
 * shapes currently observed in this repository.
 *
 * This case arises during incremental-graph persistence: when an event is stored
 * in LevelDB and later retrieved, the Luxon DateTime object is JSON-serialized.
 * In some Luxon versions the serialized form carries `_luxonDateTime` as an
 * object that stores date components under the internal `c` key rather than as
 * top-level year/month/day fields.
 *
 * @param {unknown} date
 * @returns {{ year: number, month: number, day: number } | null}
 */
function tryParseLuxonCDateParts(date) {
    if (isObject(date) && "c" in date && hasDateParts(date["c"])) {
        return date["c"];
    }
    return null;
}

/**
 * @param {unknown} date
 * @returns {{ year: number, month: number, day: number } | null}
 */
function tryParseLuxonContainerDateParts(date) {
    if (!isObject(date) || !("_luxonDateTime" in date)) {
        return null;
    }
    const luxonDate = date["_luxonDateTime"];
    if (typeof luxonDate === "string") {
        return parseIsoDateParts(luxonDate);
    }
    if (hasDateParts(luxonDate)) {
        return luxonDate;
    }
    return tryParseLuxonCDateParts(luxonDate);
}

/**
 * Graph values can carry event dates in multiple shapes:
 * - the normal DateTime wrapper used in live event objects
 * - the serialized ISO string form used in persisted event JSON
 * - cached incremental-graph values where the wrapped Luxon date survives as
 *   `_luxonDateTime`, either as an ISO string or as an object containing raw
 *   date parts.
 *
 * This helper normalizes those representations into plain date parts so the
 * asset-directory convention can be reconstructed reliably from both fresh and
 * cached graph values.
 *
 * @param {unknown} date
 * @returns {{ year: number, month: number, day: number }}
 */
function getEventDateParts(date) {
    const parsedDate =
        tryParseIsoDateParts(date) ??
        tryParseDirectDateParts(date) ??
        tryParseLuxonContainerDateParts(date);

    if (parsedDate !== null) {
        return parsedDate;
    }
    throw new Error(`Could not extract event date parts from ${JSON.stringify(date)}`);
}

/**
 * Computes the asset directory suffix for an event.
 * The canonical layout is: `<YYYY-MM>/<DD>/<event id>`
 *
 * @param {Event} event
 * @returns {string}
 */
function getEventAssetDirectorySuffix(event) {
    const date = getEventDateParts(event.date);
    const month = date.month.toString().padStart(2, "0");
    const day = date.day.toString().padStart(2, "0");
    return path.join(
        `${date.year}-${month}`,
        day,
        event.id.identifier,
    );
}

/**
 * Combines an event and its transcription after validating that the audio path
 * belongs to the event.
 *
 * @param {Event} event
 * @param {Transcription} transcription
 * @param {string} audioPath - Audio path relative to the assets root
 * @returns {EventTranscriptionEntry}
 */
function computeEventTranscription(event, transcription, audioPath) {
    // Normalize both sides to forward-slash separators so that the check is
    // consistent with the canonical `<YYYY-MM>/<DD>/<event id>/<filename>`
    // layout documented in the spec, regardless of the host OS path separator.
    const suffix = getEventAssetDirectorySuffix(event).replace(/\\/g, "/");
    const normalizedAudioPath = audioPath.replace(/\\/g, "/");
    const expectedPrefix = suffix + "/";
    if (!normalizedAudioPath.startsWith(expectedPrefix)) {
        throw new AudioNotAssociatedWithEventError(audioPath, event.id.identifier);
    }
    return { type: "event_transcription", event, transcription };
}

module.exports = {
    computeEventTranscription,
    isAudioNotAssociatedWithEventError,
};
