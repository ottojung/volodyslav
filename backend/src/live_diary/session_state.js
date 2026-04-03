/**
 * Low-level database accessors for per-session live diary state.
 *
 * All state is stored under the shared audio_session keyspace in LevelDB:
 *   audio_session/sessions/<sessionId>/live_diary/ → per-session live state fields
 *
 * @module live_diary/session_state
 */

const crypto = require("crypto");
const {
    CURRENT_SESSION_KEY,
    indexSublevel,
    sessionSublevel,
} = require("../audio_recording_session");
const { stringToTempKey } = require("../temporary");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../temporary/database/types').LiveDiaryFragmentIndexEntry} LiveDiaryFragmentIndexEntry */
/** @typedef {import('../temporary/database/types').LiveDiaryGap} LiveDiaryGap */

const LIVE_DIARY_SUBLEVEL = "live_diary";
const LIVE_DIARY_BINARY_SUBLEVEL = "binary";
const FRAGMENT_INDEX_SUBLEVEL = "fragment_index";

const LAST_FRAGMENT_KEY = stringToTempKey("last_fragment");
const LAST_FRAGMENT_FORMAT_KEY = stringToTempKey("last_fragment_mime");
const LAST_WINDOW_TRANSCRIPT_KEY = stringToTempKey("last_window_transcript");
const RUNNING_TRANSCRIPT_KEY = stringToTempKey("running_transcript");
const ASKED_QUESTIONS_KEY = stringToTempKey("asked_questions");
const PENDING_QUESTIONS_KEY = stringToTempKey("pending_questions");
const WORDS_SINCE_LAST_QUESTION_KEY = stringToTempKey("words_since_last_question");
const TRANSCRIBED_UNTIL_MS_KEY = stringToTempKey("transcribed_until_ms");
const LAST_TRANSCRIBED_RANGE_KEY = stringToTempKey("last_transcribed_range");
const KNOWN_GAPS_KEY = stringToTempKey("known_gaps");
const PULL_LOCK_KEY = stringToTempKey("pull_lock");

/** Maximum age for a pull lock before it is considered stale and released. */
const PULL_LOCK_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {import('../temporary/database').TemporarySublevel}
 */
function liveDiarySessionSublevel(temporary, sessionId) {
    return sessionSublevel(temporary, sessionId).getSublevel(LIVE_DIARY_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {import('../temporary/database').TemporaryBinarySublevel}
 */
function liveDiaryBinarySublevel(temporary, sessionId) {
    return liveDiarySessionSublevel(temporary, sessionId).getBinarySublevel(LIVE_DIARY_BINARY_SUBLEVEL);
}

/**
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {import('../temporary/database').TemporarySublevel}
 */
function fragmentIndexSublevel(temporary, sessionId) {
    return liveDiarySessionSublevel(temporary, sessionId).getSublevel(FRAGMENT_INDEX_SUBLEVEL);
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
    const entry = await liveDiaryBinarySublevel(temporary, sessionId).get(LAST_FRAGMENT_KEY);
    return entry === undefined ? null : entry;
}

/**
 * Write the last audio fragment for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {Buffer} fragment
 * @returns {Promise<void>}
 */
async function writeLastFragment(temporary, sessionId, fragment) {
    await liveDiaryBinarySublevel(temporary, sessionId).put(LAST_FRAGMENT_KEY, fragment);
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

/**
 * Commit question-generation side effects for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {string[]} askedQuestions
 * @param {Array<{text: string, intent: string}>} newQuestions
 * @param {number} cumulativeWordCount
 * @returns {Promise<void>}
 */
async function commitQuestionGenerationResult(
    temporary,
    sessionId,
    askedQuestions,
    newQuestions,
    cumulativeWordCount
) {
    const sublevel = liveDiarySessionSublevel(temporary, sessionId);
    if (newQuestions.length === 0) {
        await sublevel.put(WORDS_SINCE_LAST_QUESTION_KEY, {
            type: "live_diary_string",
            value: String(cumulativeWordCount),
        });
        return;
    }

    const existingPending = await readPendingQuestions(temporary, sessionId);
    await sublevel.batch([
        {
            type: "put",
            key: ASKED_QUESTIONS_KEY,
            value: {
                type: "live_diary_questions",
                questions: [
                    ...askedQuestions.map((text) => ({ text, intent: "" })),
                    ...newQuestions.map((q) => ({ text: q.text, intent: "" })),
                ],
            },
        },
        {
            type: "put",
            key: PENDING_QUESTIONS_KEY,
            value: {
                type: "live_diary_questions",
                questions: [...existingPending, ...newQuestions],
            },
        },
        {
            type: "put",
            key: WORDS_SINCE_LAST_QUESTION_KEY,
            value: {
                type: "live_diary_string",
                value: "0",
            },
        },
    ]);
}

// ---------------------------------------------------------------------------
// Fragment index (new pull-based architecture)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 content hash of a PCM buffer.
 * @param {Buffer} pcm
 * @returns {string} hex-encoded SHA-256 digest
 */
function computeContentHash(pcm) {
    return crypto.createHash("sha256").update(pcm).digest("hex");
}

/**
 * Pad a sequence number to 8 digits for lexicographic ordering.
 * @param {number} sequence
 * @returns {string}
 */
function padSequence(sequence) {
    return String(sequence).padStart(8, "0");
}

/**
 * Write a fragment metadata entry to the fragment index.
 * Does NOT store binary PCM (that lives in the audio-session chunk sublevel).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {{ sequence: number, startMs: number, endMs: number, contentHash: string, ingestedAtMs: number, sampleRateHz: number, channels: number, bitDepth: number }} fragmentMeta
 * @returns {Promise<void>}
 */
async function writeFragmentIndex(temporary, sessionId, fragmentMeta) {
    const key = stringToTempKey(padSequence(fragmentMeta.sequence));
    await fragmentIndexSublevel(temporary, sessionId).put(key, {
        type: "live_diary_fragment_index",
        ...fragmentMeta,
    });
}

/**
 * Read a single fragment metadata entry by sequence.
 * Returns null if not found.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {number} sequence
 * @returns {Promise<LiveDiaryFragmentIndexEntry | null>}
 */
async function readFragmentIndex(temporary, sessionId, sequence) {
    const key = stringToTempKey(padSequence(sequence));
    const entry = await fragmentIndexSublevel(temporary, sessionId).get(key);
    if (entry === undefined || entry.type !== "live_diary_fragment_index") {
        return null;
    }
    return entry;
}

/**
 * List all fragment metadata entries for a session, sorted by (startMs, sequence).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<LiveDiaryFragmentIndexEntry[]>}
 */
async function listFragmentIndex(temporary, sessionId) {
    const keys = await fragmentIndexSublevel(temporary, sessionId).listKeys();
    /** @type {LiveDiaryFragmentIndexEntry[]} */
    const fragments = [];
    for (const key of keys) {
        const entry = await fragmentIndexSublevel(temporary, sessionId).get(key);
        if (entry !== undefined && entry.type === "live_diary_fragment_index") {
            fragments.push(entry);
        }
    }
    // Sort by (startMs, sequence) for deterministic ordering.
    fragments.sort((a, b) => a.startMs !== b.startMs ? a.startMs - b.startMs : a.sequence - b.sequence);
    return fragments;
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

/**
 * Read the transcribed-until watermark (ms).
 * Returns 0 if not set (nothing transcribed yet).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
async function readTranscribedUntilMs(temporary, sessionId) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(TRANSCRIBED_UNTIL_MS_KEY);
    if (entry === undefined || entry.type !== "live_diary_string") {
        return 0;
    }
    return parseInt(entry.value, 10) || 0;
}

/**
 * Write the transcribed-until watermark (ms).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function writeTranscribedUntilMs(temporary, sessionId, ms) {
    await liveDiarySessionSublevel(temporary, sessionId).put(TRANSCRIBED_UNTIL_MS_KEY, {
        type: "live_diary_string",
        value: String(ms),
    });
}

// ---------------------------------------------------------------------------
// Last transcribed range (for overlap planner)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LastTranscribedRange
 * @property {number} firstStartMs
 * @property {number} lastEndMs
 * @property {number} fragmentCount
 */

/**
 * Read the last-transcribed-range metadata.
 * Returns null if not set (no prior pull).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<LastTranscribedRange | null>}
 */
async function readLastTranscribedRange(temporary, sessionId) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(LAST_TRANSCRIBED_RANGE_KEY);
    if (entry === undefined || entry.type !== "live_diary_last_range") {
        return null;
    }
    return { firstStartMs: entry.firstStartMs, lastEndMs: entry.lastEndMs, fragmentCount: entry.fragmentCount };
}

/**
 * Write the last-transcribed-range metadata.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {LastTranscribedRange} range
 * @returns {Promise<void>}
 */
async function writeLastTranscribedRange(temporary, sessionId, range) {
    await liveDiarySessionSublevel(temporary, sessionId).put(LAST_TRANSCRIBED_RANGE_KEY, {
        type: "live_diary_last_range",
        firstStartMs: range.firstStartMs,
        lastEndMs: range.lastEndMs,
        fragmentCount: range.fragmentCount,
    });
}

// ---------------------------------------------------------------------------
// Known gaps
// ---------------------------------------------------------------------------

/**
 * Read the known-gaps list.
 * Returns empty array if not set.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<LiveDiaryGap[]>}
 */
async function readKnownGaps(temporary, sessionId) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(KNOWN_GAPS_KEY);
    if (entry === undefined || entry.type !== "live_diary_gaps") {
        return [];
    }
    return entry.gaps;
}

/**
 * Write the known-gaps list.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {LiveDiaryGap[]} gaps
 * @returns {Promise<void>}
 */
async function writeKnownGaps(temporary, sessionId, gaps) {
    await liveDiarySessionSublevel(temporary, sessionId).put(KNOWN_GAPS_KEY, {
        type: "live_diary_gaps",
        gaps,
    });
}

// ---------------------------------------------------------------------------
// Pull lock
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire the pull lock for a session.
 * Returns true if the lock was acquired, false if it is already held.
 * A stale lock (older than PULL_LOCK_MAX_AGE_MS) is automatically cleared.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {Promise<boolean>}
 */
async function acquirePullLock(temporary, sessionId, nowMs) {
    const entry = await liveDiarySessionSublevel(temporary, sessionId).get(PULL_LOCK_KEY);
    if (entry !== undefined && entry.type === "live_diary_string") {
        const lockAcquiredAt = parseInt(entry.value, 10) || 0;
        if (nowMs - lockAcquiredAt < PULL_LOCK_MAX_AGE_MS) {
            return false; // Lock is still valid.
        }
        // Stale lock — fall through to re-acquire.
    }
    await liveDiarySessionSublevel(temporary, sessionId).put(PULL_LOCK_KEY, {
        type: "live_diary_string",
        value: String(nowMs),
    });
    return true;
}

/**
 * Release the pull lock for a session.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function releasePullLock(temporary, sessionId) {
    await liveDiarySessionSublevel(temporary, sessionId).del(PULL_LOCK_KEY);
}

module.exports = {
    LAST_FRAGMENT_FORMAT_KEY,
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
    ASKED_QUESTIONS_KEY,
    PENDING_QUESTIONS_KEY,
    WORDS_SINCE_LAST_QUESTION_KEY,
    TRANSCRIBED_UNTIL_MS_KEY,
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
    commitQuestionGenerationResult,
    computeContentHash,
    writeFragmentIndex,
    readFragmentIndex,
    listFragmentIndex,
    readTranscribedUntilMs,
    writeTranscribedUntilMs,
    readLastTranscribedRange,
    writeLastTranscribedRange,
    readKnownGaps,
    writeKnownGaps,
    acquirePullLock,
    releasePullLock,
};
