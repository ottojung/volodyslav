/**
 * LevelDB key builders for the audio recording session keyspace.
 * All keys live under the "audio_session/" namespace.
 * @module audio_recording_session/keys
 */

const { stringToTempKey } = require("../temporary");

/** @typedef {import('../temporary/database/types').TempKey} TempKey */

const SESSION_NAMESPACE = "audio_session";
const CURRENT_SESSION_KEY = stringToTempKey(`${SESSION_NAMESPACE}/index/current_session_id`);

/**
 * @param {string} sessionId
 * @returns {TempKey}
 */
function metaKey(sessionId) {
    return stringToTempKey(`${SESSION_NAMESPACE}/${sessionId}/meta`);
}

/**
 * @param {string} sessionId
 * @param {number} sequence
 * @returns {TempKey}
 */
function chunkKey(sessionId, sequence) {
    const seqPadded = String(sequence).padStart(6, "0");
    return stringToTempKey(`${SESSION_NAMESPACE}/${sessionId}/chunk/${seqPadded}`);
}

/**
 * @param {string} sessionId
 * @returns {TempKey}
 */
function finalKey(sessionId) {
    return stringToTempKey(`${SESSION_NAMESPACE}/${sessionId}/final`);
}

/**
 * Prefix for all keys belonging to a session (for bulk delete).
 * @param {string} sessionId
 * @returns {string}
 */
function sessionPrefix(sessionId) {
    return `${SESSION_NAMESPACE}/${sessionId}/`;
}

/** @typedef {import('../temporary').Temporary} Temporary */

/**
 * Delete all data for a session (all keys with the session prefix).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function deleteSessionData(temporary, sessionId) {
    await temporary.deleteKeysByPrefix(sessionPrefix(sessionId));
}

module.exports = {
    SESSION_NAMESPACE,
    CURRENT_SESSION_KEY,
    metaKey,
    chunkKey,
    finalKey,
    sessionPrefix,
    deleteSessionData,
};
