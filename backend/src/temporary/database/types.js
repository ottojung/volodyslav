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
 * @property {string} mimeType
 * @property {number} fragmentCount
 * @property {number} lastSequence
 * @property {number} lastEndMs
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
 * The union of all value types stored in the temporary database.
 * @typedef {BlobEntry | DoneEntry | RuntimeStateEntry | AudioSessionMetaEntry | AudioSessionIndexEntry} TempEntry
 */

module.exports = {
    TempKeyClass,
    stringToTempKey,
    tempKeyToString,
};
