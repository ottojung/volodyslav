/**
 * LevelDB key builders for the live diary questioning keyspace.
 * All data lives under temporary sublevels rooted at "live_diary".
 *
 * Key layout:
 *   live_diary/index/current_session_id → { type: "live_diary_index", sessionId: "..." }
 *   live_diary/index/session/<id>       → { type: "done" }  (exists marker)
 *   live_diary/sessions/<sessionId>/last_fragment         → BlobEntry
 *   live_diary/sessions/<sessionId>/last_fragment_mime    → LiveDiaryStringEntry
 *   live_diary/sessions/<sessionId>/last_window_transcript → LiveDiaryStringEntry
 *   live_diary/sessions/<sessionId>/running_transcript    → LiveDiaryStringEntry
 *   live_diary/sessions/<sessionId>/asked_questions       → LiveDiaryQuestionsEntry
 *
 * @module live_diary/keys
 */

const { stringToTempKey } = require("../temporary");

/** @typedef {import('../temporary/database/types').TempKey} TempKey */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../temporary/database').TemporarySublevel} TemporarySublevel */

const LIVE_DIARY_NAMESPACE = "live_diary";
const INDEX_SUBLEVEL = "index";
const SESSIONS_SUBLEVEL = "sessions";

const CURRENT_SESSION_KEY = stringToTempKey("current_session_id");
const SESSION_INDEX_KEY_PREFIX = "session/";
const LAST_FRAGMENT_KEY = stringToTempKey("last_fragment");
const LAST_FRAGMENT_MIME_KEY = stringToTempKey("last_fragment_mime");
const LAST_WINDOW_TRANSCRIPT_KEY = stringToTempKey("last_window_transcript");
const RUNNING_TRANSCRIPT_KEY = stringToTempKey("running_transcript");
const ASKED_QUESTIONS_KEY = stringToTempKey("asked_questions");

/**
 * @param {Temporary} temporary
 * @returns {TemporarySublevel}
 */
function liveDiaryRootSublevel(temporary) {
    return temporary.getSublevel(LIVE_DIARY_NAMESPACE);
}

/**
 * @param {Temporary} temporary
 * @returns {TemporarySublevel}
 */
function indexSublevel(temporary) {
    return liveDiaryRootSublevel(temporary).getSublevel(INDEX_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @returns {TemporarySublevel}
 */
function sessionsSublevel(temporary) {
    return liveDiaryRootSublevel(temporary).getSublevel(SESSIONS_SUBLEVEL);
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
 * List all known live diary session ids.
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
 * Delete all state data for a live diary session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function deleteSessionData(temporary, sessionId) {
    await sessionSublevel(temporary, sessionId).clear();
}

module.exports = {
    LIVE_DIARY_NAMESPACE,
    CURRENT_SESSION_KEY,
    SESSION_INDEX_KEY_PREFIX,
    LAST_FRAGMENT_KEY,
    LAST_FRAGMENT_MIME_KEY,
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
    ASKED_QUESTIONS_KEY,
    liveDiaryRootSublevel,
    indexSublevel,
    sessionsSublevel,
    sessionSublevel,
    sessionMarkerKey,
    sessionIdFromMarkerKey,
    markSessionExists,
    unmarkSessionExists,
    listKnownSessionIds,
    deleteSessionData,
};
