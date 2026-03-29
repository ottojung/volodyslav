/**
 * @typedef {import('../temporary').Temporary} Temporary
 * @typedef {import('../temporary/database/types').AudioSessionMeta} AudioSessionMeta
 */

const { CURRENT_SESSION_KEY, indexSublevel, sessionSublevel, metaKey } = require("./keys");

/**
 * Read session metadata from the database.
 * Returns null if not found.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<AudioSessionMeta | null>}
 */
async function readMeta(temporary, sessionId) {
    const entry = await sessionSublevel(temporary, sessionId).get(metaKey());
    if (entry === undefined || entry.type !== "audio_session_meta") {
        return null;
    }
    return entry.data;
}

/**
 * Write session metadata to the database.
 * @param {Temporary} temporary
 * @param {AudioSessionMeta} meta
 * @returns {Promise<void>}
 */
async function writeMeta(temporary, meta) {
    await sessionSublevel(temporary, meta.sessionId).put(metaKey(), { type: "audio_session_meta", data: meta });
}

/**
 * Read the current session id from the index. Returns null if not set.
 * @param {Temporary} temporary
 * @returns {Promise<string | null>}
 */
async function readCurrentSessionId(temporary) {
    const entry = await indexSublevel(temporary).get(CURRENT_SESSION_KEY);
    if (entry === undefined || entry.type !== "audio_session_index") {
        return null;
    }
    return entry.sessionId;
}

/**
 * Write the current session id to the index.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function writeCurrentSessionId(temporary, sessionId) {
    await indexSublevel(temporary).put(CURRENT_SESSION_KEY, { type: "audio_session_index", sessionId });
}

module.exports = {
    readMeta,
    writeMeta,
    readCurrentSessionId,
    writeCurrentSessionId,
};
