const path = require("path");
const { fromISOString } = require("../../../datetime");

/** @typedef {import('../../incremental_graph/database/types').AssociatedAudioEntry} AssociatedAudioEntry */
/** @typedef {import('../../incremental_graph/database/types').AllAssociatedAudioEntry} AllAssociatedAudioEntry */
/** @typedef {import('../../../event').Event} Event */

/**
 * @typedef {object} AssociatedAudioCapabilities
 * @property {import('../../../environment').Environment} environment
 * @property {import('../../../filesystem/dirscanner').DirScanner} scanner
 */

const AUDIO_EXTENSIONS = new Set([
    ".aac",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".wav",
    ".webm",
]);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFilename(filename) {
    return AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

class EventDatePartsError extends Error {
    /**
     * @param {unknown} date
     */
    constructor(date) {
        super(`Could not extract event date parts from ${JSON.stringify(date)}`);
        this.name = "EventDatePartsError";
        this.date = date;
    }
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
 * Graph values can carry event dates in multiple shapes:
 * - the normal DateTime wrapper used in live event objects
 * - the serialized ISO string form used in persisted event JSON
 * - cached incremental-graph values where the wrapped Luxon date survives as
 *   `_luxonDateTime`, either as an ISO string or as an object containing raw
 *   year/month/day fields.
 *
 * This helper normalizes those representations into plain date parts so the
 * asset-directory convention can be reconstructed reliably from both fresh and
 * cached graph values.
 *
 * @param {unknown} date
 * @returns {{ year: number, month: number, day: number }}
 */
function getEventDateParts(date) {
    if (typeof date === "string") {
        const parsed = fromISOString(date);
        return {
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
        };
    }
    if (hasDateParts(date)) {
        return date;
    }
    const luxonDate = getLuxonDateContainer(date);
    if (typeof luxonDate === "string") {
        const parsed = fromISOString(luxonDate);
        return {
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
        };
    }
    if (hasDateParts(luxonDate)) {
        return luxonDate;
    }
    if (isObject(luxonDate) && "c" in luxonDate && hasDateParts(luxonDate["c"])) {
        return luxonDate["c"];
    }
    if (isObject(date) && "c" in date && hasDateParts(date["c"])) {
        return date["c"];
    }
    if (isObject(date) && "toISOString" in date && typeof date["toISOString"] === "function") {
        const parsed = fromISOString(date["toISOString"]());
        return {
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
        };
    }
    throw new EventDatePartsError(date);
}

/**
 * @param {unknown} candidate
 * @returns {candidate is Record<string, unknown>}
 */
function isObject(candidate) {
    return candidate !== null && typeof candidate === "object";
}

/**
 * @param {unknown} candidate
 * @returns {unknown}
 */
function getLuxonDateContainer(candidate) {
    if (!isObject(candidate)) {
        return undefined;
    }
    if ("_luxonDateTime" in candidate) {
        return candidate["_luxonDateTime"];
    }
    return undefined;
}

/**
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
 * @param {AssociatedAudioCapabilities} capabilities
 * @param {Event} event
 * @returns {string}
 */
function getEventAssetDirectory(capabilities, event) {
    return path.join(
        capabilities.environment.eventLogAssetsDirectory(),
        getEventAssetDirectorySuffix(event),
    );
}

/**
 * @param {AssociatedAudioCapabilities} capabilities
 * @param {Event} event
 * @returns {Promise<string[]>}
 */
async function listAssociatedAudioPaths(capabilities, event) {
    const assetDirectory = getEventAssetDirectory(capabilities, event);
    const members = await capabilities.scanner.scanDirectory(assetDirectory).catch(() => {
        return [];
    });

    return members
        .map((member) => path.basename(member.path))
        .filter(isAudioFilename)
        .sort()
        .map((filename) => path.join(getEventAssetDirectorySuffix(event), filename));
}

/**
 * @param {Event} event
 * @param {AssociatedAudioCapabilities} capabilities
 * @returns {Promise<AssociatedAudioEntry>}
 */
async function computeAssociatedAudioForEvent(event, capabilities) {
    const value = await listAssociatedAudioPaths(capabilities, event);
    return {
        type: "associated_audio",
        value,
    };
}

/**
 * @param {Array<Event>} events
 * @param {AssociatedAudioCapabilities} capabilities
 * @returns {Promise<AllAssociatedAudioEntry>}
 */
async function computeAllAssociatedAudio(events, capabilities) {
    const grouped = await Promise.all(
        events.map((event) => listAssociatedAudioPaths(capabilities, event))
    );
    return {
        type: "all_associated_audio",
        value: grouped.flat(),
    };
}

module.exports = {
    computeAssociatedAudioForEvent,
    computeAllAssociatedAudio,
};
