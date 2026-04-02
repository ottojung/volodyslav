/**
 * LevelDB key builders for the audio recording session keyspace.
 * All data lives under temporary sublevels rooted at "audio_session".
 * @module audio_recording_session/keys
 */

const { stringToTempKey } = require("../temporary");

/** @typedef {import('../temporary/database/types').TempKey} TempKey */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../temporary/database').TemporarySublevel} TemporarySublevel */

const SESSION_NAMESPACE = "audio_session";
const INDEX_SUBLEVEL = "index";
const SESSIONS_SUBLEVEL = "sessions";
const SESSION_BINARY_SUBLEVEL = "binary";
const CHUNKS_SUBLEVEL = "chunk";
const CURRENT_SESSION_KEY = stringToTempKey("current_session_id");
const SESSION_INDEX_KEY_PREFIX = "session/";
const META_KEY = stringToTempKey("meta");
const FINAL_KEY = stringToTempKey("final");

/**
 * @param {Temporary} temporary
 * @returns {TemporarySublevel}
 */
function audioSessionRootSublevel(temporary) {
    return temporary.getSublevel(SESSION_NAMESPACE);
}

/**
 * @param {Temporary} temporary
 * @returns {TemporarySublevel}
 */
function indexSublevel(temporary) {
    return audioSessionRootSublevel(temporary).getSublevel(INDEX_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @returns {TemporarySublevel}
 */
function sessionsSublevel(temporary) {
    return audioSessionRootSublevel(temporary).getSublevel(SESSIONS_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {TemporarySublevel}
 */
function sessionSublevel(temporary, sessionId) {
    return sessionsSublevel(temporary).getSublevel(sessionId);
}

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {TemporarySublevel}
 */
function chunksSublevel(temporary, sessionId) {
    return sessionSublevel(temporary, sessionId).getSublevel(CHUNKS_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {import('../temporary/database').TemporaryBinarySublevel}
 */
function sessionBinarySublevel(temporary, sessionId) {
    return sessionSublevel(temporary, sessionId).getBinarySublevel(SESSION_BINARY_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {import('../temporary/database').TemporaryBinarySublevel}
 */
function chunksBinarySublevel(temporary, sessionId) {
    return sessionBinarySublevel(temporary, sessionId).getSublevel(CHUNKS_SUBLEVEL);
}

/**
 * @returns {TempKey}
 */
function metaKey() {
    return META_KEY;
}

/**
 * @param {number} sequence
 * @returns {TempKey}
 */
function chunkKey(sequence) {
    const seqPadded = String(sequence).padStart(6, "0");
    return stringToTempKey(seqPadded);
}

/**
 * @returns {TempKey}
 */
function finalKey() {
    return FINAL_KEY;
}

/**
 * @param {string} sessionId
 * @returns {TempKey}
 */
function sessionMarkerKey(sessionId) {
    return stringToTempKey(`${SESSION_INDEX_KEY_PREFIX}${sessionId}`);
}

/**
 * @param {TempKey} key
 * @returns {string | null}
 */
function sessionIdFromMarkerKey(key) {
    const keyString = String(key);
    if (!keyString.startsWith(SESSION_INDEX_KEY_PREFIX)) {
        return null;
    }
    return keyString.slice(SESSION_INDEX_KEY_PREFIX.length);
}

/**
 * Mark a session id as existing in the index.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function markSessionExists(temporary, sessionId) {
    await indexSublevel(temporary).put(sessionMarkerKey(sessionId), { type: "done" });
}

/**
 * Unmark a session id in the index.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function unmarkSessionExists(temporary, sessionId) {
    await indexSublevel(temporary).del(sessionMarkerKey(sessionId));
}

/**
 * List all known session ids.
 * @param {Temporary} temporary
 * @returns {Promise<string[]>}
 */
async function listKnownSessionIds(temporary) {
    /** @type {string[]} */
    const sessionIds = [];
    const keys = await indexSublevel(temporary).listKeys();
    for (const key of keys) {
        const sessionId = sessionIdFromMarkerKey(key);
        if (sessionId !== null) {
            sessionIds.push(sessionId);
        }
    }
    return sessionIds;
}

/**
 * Delete all data for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function deleteSessionData(temporary, sessionId) {
    await sessionSublevel(temporary, sessionId).clear();
}

module.exports = {
    SESSION_NAMESPACE,
    CURRENT_SESSION_KEY,
    audioSessionRootSublevel,
    indexSublevel,
    sessionsSublevel,
    sessionSublevel,
    chunksSublevel,
    chunksBinarySublevel,
    sessionBinarySublevel,
    metaKey,
    chunkKey,
    finalKey,
    sessionMarkerKey,
    sessionIdFromMarkerKey,
    markSessionExists,
    unmarkSessionExists,
    listKnownSessionIds,
    deleteSessionData,
};
