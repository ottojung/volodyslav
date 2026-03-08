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
    if (
        date !== null &&
        typeof date === "object" &&
        "_luxonDateTime" in date &&
        typeof date._luxonDateTime === "string"
    ) {
        const parsed = fromISOString(date._luxonDateTime);
        return {
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
        };
    }
    if (
        date !== null &&
        typeof date === "object" &&
        "_luxonDateTime" in date &&
        hasDateParts(date._luxonDateTime)
    ) {
        return date._luxonDateTime;
    }
    if (
        date !== null &&
        typeof date === "object" &&
        "_luxonDateTime" in date &&
        date._luxonDateTime !== null &&
        typeof date._luxonDateTime === "object" &&
        "c" in date._luxonDateTime &&
        hasDateParts(date._luxonDateTime.c)
    ) {
        return date._luxonDateTime.c;
    }
    if (date !== null && typeof date === "object" && "c" in date && hasDateParts(date.c)) {
        return date.c;
    }
    if (date !== null && typeof date === "object" && "toISOString" in date && typeof date.toISOString === "function") {
        const parsed = fromISOString(date.toISOString());
        return {
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
        };
    }
    throw new EventDatePartsError(date);
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
