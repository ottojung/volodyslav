/**
 * Type definitions for the temporary database.
 *
 * Inspired by generators/incremental_graph/database/types.js.
 * Uses the same nominal-type / branded-string pattern.
 */

/** @typedef {import('../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../logger').Logger} Logger */
/** @typedef {import('../../level_database').LevelDatabase} LevelDatabase */
/** @typedef {import('../../environment').Environment} Environment */

/**
 * Capabilities needed to open the temporary database.
 * @typedef {object} DatabaseCapabilities
 * @property {FileCreator} creator - A file creator instance (used to ensure the DB directory exists)
 * @property {Logger} logger - A logger instance
 * @property {LevelDatabase} levelDatabase - A level database factory
 * @property {Environment} environment - An environment instance
 */

// ---------------------------------------------------------------------------
// TempKey – a branded string that is used as a LevelDB key
// ---------------------------------------------------------------------------

class TempKeyClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;

    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("TempKey is a nominal type and cannot be instantiated directly");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is TempKey}
 */
function castToTempKey(_value) {
    return true;
}

/**
 * Convert a plain string to a TempKey.
 * @param {string} str
 * @returns {TempKey}
 */
function stringToTempKey(str) {
    if (castToTempKey(str)) {
        return str;
    }
    throw new Error("Invalid TempKey string");
}

/**
 * Convert a TempKey back to a plain string.
 * @param {TempKey} key
 * @returns {string}
 */
function tempKeyToString(key) {
    if (typeof key === "string") {
        return key;
    }
    throw new Error("Invalid TempKey type");
}

/**
 * A branded string used as a key in the temporary LevelDB store.
 * @typedef {TempKeyClass} TempKey
 */

// ---------------------------------------------------------------------------
// TempEntry – the discriminated union stored as a JSON value
// ---------------------------------------------------------------------------

/**
 * A stored binary blob (base64-encoded).
 * @typedef {object} BlobEntry
 * @property {'blob'} type
 * @property {string} data - Base64-encoded binary content
 */

/**
 * A stored request-completion marker.
 * @typedef {object} DoneEntry
 * @property {'done'} type
 */

/**
 * A stored runtime state entry.
 * @typedef {object} RuntimeStateEntry
 * @property {'runtime_state'} type
 * @property {Record<string, unknown>} data - Serialized runtime state object
 */

/**
 * Audio session metadata shape.
 * @typedef {object} AudioSessionMeta
 * @property {string} sessionId
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {'recording'|'stopped'} status
 * @property {string} mimeType - always "audio/wav" for PCM-native sessions
 * @property {number} fragmentCount
 * @property {number} lastSequence
 * @property {number} lastEndMs
 * @property {number} elapsedSeconds - elapsed recording time in seconds (set on stop)
 * @property {number} sampleRateHz - PCM sample rate; 0 when no chunks uploaded yet
 * @property {number} channels - PCM channel count; 0 when no chunks uploaded yet
 * @property {number} bitDepth - PCM bit depth; 0 when no chunks uploaded yet
 */

/**
 * Audio session metadata entry.
 * @typedef {object} AudioSessionMetaEntry
 * @property {'audio_session_meta'} type
 * @property {AudioSessionMeta} data - Serialized session metadata object
 */

/**
 * Audio session index entry (tracks current session id).
 * @typedef {object} AudioSessionIndexEntry
 * @property {'audio_session_index'} type
 * @property {string} sessionId
 */

/**
 * Live diary session index entry (tracks current session id).
 * @typedef {object} LiveDiaryIndexEntry
 * @property {'live_diary_index'} type
 * @property {string} sessionId
 */

/**
 * Live diary string field entry (stores a single string value).
 * @typedef {object} LiveDiaryStringEntry
 * @property {'live_diary_string'} type
 * @property {string} value
 */

/**
 * A single diary question.
 * @typedef {object} LiveDiaryQuestion
 * @property {string} text
 * @property {string} intent
 */

/**
 * Live diary asked-questions list entry.
 * @typedef {object} LiveDiaryQuestionsEntry
 * @property {'live_diary_questions'} type
 * @property {LiveDiaryQuestion[]} questions
 */

/**
 * The union of all value types stored in the temporary database.
 * @typedef {BlobEntry | DoneEntry | RuntimeStateEntry | AudioSessionMetaEntry | AudioSessionIndexEntry | LiveDiaryIndexEntry | LiveDiaryStringEntry | LiveDiaryQuestionsEntry} TempEntry
 */

module.exports = {
    TempKeyClass,
    stringToTempKey,
    tempKeyToString,
};
