/**
 * Low-level database accessors for per-session live diary state.
 *
 * All state is stored under the shared audio_session keyspace in LevelDB:
 *   audio_session/sessions/<sessionId>/live_diary/ → per-session live state fields
 *
 * @module live_diary/session_state
 */

const {
    CURRENT_SESSION_KEY,
    indexSublevel,
    sessionSublevel,
} = require("../audio_recording_session");
const { stringToTempKey } = require("../temporary");

/** @typedef {import('../temporary').Temporary} Temporary */

const LIVE_DIARY_SUBLEVEL = "live_diary";

const LAST_FRAGMENT_KEY = stringToTempKey("last_fragment");
const LAST_FRAGMENT_FORMAT_KEY = stringToTempKey("last_fragment_mime");
const LAST_WINDOW_TRANSCRIPT_KEY = stringToTempKey("last_window_transcript");
const RUNNING_TRANSCRIPT_KEY = stringToTempKey("running_transcript");
const ASKED_QUESTIONS_KEY = stringToTempKey("asked_questions");
const PENDING_QUESTIONS_KEY = stringToTempKey("pending_questions");
const WORDS_SINCE_LAST_QUESTION_KEY = stringToTempKey("words_since_last_question");

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {import('../temporary/database').TemporarySublevel}
 */
function liveDiarySessionSublevel(temporary, sessionId) {
    return sessionSublevel(temporary, sessionId).getSublevel(LIVE_DIARY_SUBLEVEL);
}

/**
 * Read the current session id from the index.
 * Returns null if not set.
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
    await indexSublevel(temporary).put(CURRENT_SESSION_KEY, {
        type: "audio_session_index",
        sessionId,
    });
}

/**
 * Read the stored last audio fragment for a session.
 * Returns null if none stored.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<Buffer | null>}
 */
async function readLastFragment(temporary, sessionId) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(LAST_FRAGMENT_KEY);
    if (entry === undefined || entry.type !== "blob") {
        return null;
    }
    return Buffer.from(entry.data, "base64");
}

/**
 * Write the last audio fragment for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {Buffer} fragment
 * @returns {Promise<void>}
 */
async function writeLastFragment(temporary, sessionId, fragment) {
    await liveDiarySessionSublevel(temporary, sessionId).put(LAST_FRAGMENT_KEY, {
        type: "blob",
        data: fragment.toString("base64"),
    });
}

/**
 * Read a string field for a session.
 * Returns empty string if not set.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {import('../temporary/database/types').TempKey} key
 * @returns {Promise<string>}
 */
async function readStringField(temporary, sessionId, key) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(key);
    if (entry === undefined || entry.type !== "live_diary_string") {
        return "";
    }
    return entry.value;
}

/**
 * Write a string field for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {import('../temporary/database/types').TempKey} key
 * @param {string} value
 * @returns {Promise<void>}
 */
async function writeStringField(temporary, sessionId, key, value) {
    await liveDiarySessionSublevel(temporary, sessionId).put(key, {
        type: "live_diary_string",
        value,
    });
}

/**
 * Read the asked-questions list for a session.
 * Returns empty array if not set.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<string[]>}
 */
async function readAskedQuestions(temporary, sessionId) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(ASKED_QUESTIONS_KEY);
    if (entry === undefined || entry.type !== "live_diary_questions") {
        return [];
    }
    return entry.questions.map((q) => q.text);
}

/**
 * Write the asked-questions list for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {string[]} questions
 * @returns {Promise<void>}
 */
async function writeAskedQuestions(temporary, sessionId, questions) {
    await liveDiarySessionSublevel(temporary, sessionId).put(ASKED_QUESTIONS_KEY, {
        type: "live_diary_questions",
        questions: questions.map((text) => ({ text, intent: "" })),
    });
}

/**
 * Read pending questions (not yet fetched by the client) for a session.
 * Returns empty array if not set.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<Array<{text: string, intent: string}>>}
 */
async function readPendingQuestions(temporary, sessionId) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(PENDING_QUESTIONS_KEY);
    if (entry === undefined || entry.type !== "live_diary_questions") {
        return [];
    }
    return entry.questions;
}

/**
 * Append questions to the pending questions list for a session.
 * This read-modify-write is safe because the route handler serializes AI
 * processing per session via `processingQueues`, so concurrent calls for the
 * same session are impossible.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {Array<{text: string, intent: string}>} newQuestions
 * @returns {Promise<void>}
 */
async function appendPendingQuestions(temporary, sessionId, newQuestions) {
    const existing = await readPendingQuestions(temporary, sessionId);
    await liveDiarySessionSublevel(temporary, sessionId).put(PENDING_QUESTIONS_KEY, {
        type: "live_diary_questions",
        questions: [...existing, ...newQuestions],
    });
}

/**
 * Clear all pending questions for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function clearPendingQuestions(temporary, sessionId) {
    await liveDiarySessionSublevel(temporary, sessionId).put(PENDING_QUESTIONS_KEY, {
        type: "live_diary_questions",
        questions: [],
    });
}

module.exports = {
    LAST_FRAGMENT_FORMAT_KEY,
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
    ASKED_QUESTIONS_KEY,
    PENDING_QUESTIONS_KEY,
    WORDS_SINCE_LAST_QUESTION_KEY,
    readCurrentSessionId,
    writeCurrentSessionId,
    readLastFragment,
    writeLastFragment,
    readStringField,
    writeStringField,
    readAskedQuestions,
    writeAskedQuestions,
    readPendingQuestions,
    appendPendingQuestions,
    clearPendingQuestions,
};
