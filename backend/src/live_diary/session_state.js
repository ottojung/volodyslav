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

const LAST_WINDOW_TRANSCRIPT_KEY = stringToTempKey("last_window_transcript");
const RUNNING_TRANSCRIPT_KEY = stringToTempKey("running_transcript");
const ASKED_QUESTIONS_KEY = stringToTempKey("asked_questions");
const PENDING_QUESTIONS_KEY = stringToTempKey("pending_questions");
const WORDS_SINCE_LAST_QUESTION_KEY = stringToTempKey("words_since_last_question");
const TRANSCRIBED_UNTIL_MS_KEY = stringToTempKey("transcribed_until_ms");
const LAST_TRANSCRIBED_RANGE_KEY = stringToTempKey("last_transcribed_range");
const KNOWN_GAPS_KEY = stringToTempKey("known_gaps");


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
// Atomic pull-state commit
// ---------------------------------------------------------------------------

/**
 * @typedef {object} QuestionCommit
 * @property {string[]} askedQuestions - Previously asked questions (for deduplication).
 * @property {Array<{text: string, intent: string}>} newQuestions - Newly generated questions.
 * @property {number} cumulativeWordCount - Word count to persist.
 * @property {Array<{text: string, intent: string}>} existingPending - Current pending queue
 *   (read before question generation so the batch stays atomic).
 */

/**
 * @typedef {object} PullStateCommit
 * @property {number} transcribedUntilMs - New watermark.
 * @property {import('../temporary/database/types').LiveDiaryGap[]} knownGaps - Updated gap list.
 * @property {LastTranscribedRange | null} lastRange - Updated last-range metadata (null to leave unchanged).
 * @property {string} lastWindowTranscript - New last-window transcript.
 * @property {string} runningTranscript - New running transcript.
 * @property {number} wordsSinceLastQuestion - Word count to persist (used when no question generation).
 * @property {QuestionCommit | null} questionCommit - If non-null, commit question state in the same
 *   batch as the watermark to prevent crash gaps between the two writes.
 */

/**
 * Atomically commit all pull-cycle state updates in a single batch.
 *
 * When `state.questionCommit` is provided, the question generation results
 * (asked/pending questions, word count) are committed in the same LevelDB
 * batch as the watermark, eliminating the crash window between the two writes.
 *
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {PullStateCommit} state
 * @returns {Promise<void>}
 */
async function commitPullState(temporary, sessionId, state) {
    const sublevel = liveDiarySessionSublevel(temporary, sessionId);
    /** @type {Array<{type: 'put', key: import('../temporary/database/types').TempKey, value: import('../temporary/database/types').TempEntry} | {type: 'del', key: import('../temporary/database/types').TempKey}>} */
    const ops = [
        { type: "put", key: TRANSCRIBED_UNTIL_MS_KEY, value: { type: "live_diary_string", value: String(state.transcribedUntilMs) } },
        { type: "put", key: KNOWN_GAPS_KEY, value: { type: "live_diary_gaps", gaps: state.knownGaps } },
        { type: "put", key: LAST_WINDOW_TRANSCRIPT_KEY, value: { type: "live_diary_string", value: state.lastWindowTranscript } },
        { type: "put", key: RUNNING_TRANSCRIPT_KEY, value: { type: "live_diary_string", value: state.runningTranscript } },
    ];
    if (state.lastRange !== null) {
        ops.push({ type: "put", key: LAST_TRANSCRIBED_RANGE_KEY, value: { type: "live_diary_last_range", firstStartMs: state.lastRange.firstStartMs, lastEndMs: state.lastRange.lastEndMs, fragmentCount: state.lastRange.fragmentCount } });
    }

    const qc = state.questionCommit;
    if (qc !== null && qc.newQuestions.length > 0) {
        // Commit new questions atomically with the watermark.
        ops.push(
            { type: "put", key: ASKED_QUESTIONS_KEY, value: { type: "live_diary_questions", questions: [...qc.askedQuestions.map((text) => ({ text, intent: "" })), ...qc.newQuestions.map((q) => ({ text: q.text, intent: "" }))] } },
            { type: "put", key: PENDING_QUESTIONS_KEY, value: { type: "live_diary_questions", questions: [...qc.existingPending, ...qc.newQuestions] } },
            { type: "put", key: WORDS_SINCE_LAST_QUESTION_KEY, value: { type: "live_diary_string", value: "0" } }
        );
    } else {
        ops.push({ type: "put", key: WORDS_SINCE_LAST_QUESTION_KEY, value: { type: "live_diary_string", value: String(qc !== null ? qc.cumulativeWordCount : state.wordsSinceLastQuestion) } });
    }

    await sublevel.batch(ops);
}

// ---------------------------------------------------------------------------

module.exports = {
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
    ASKED_QUESTIONS_KEY,
    PENDING_QUESTIONS_KEY,
    WORDS_SINCE_LAST_QUESTION_KEY,
    TRANSCRIBED_UNTIL_MS_KEY,
    readCurrentSessionId,
    writeCurrentSessionId,
    readStringField,
    writeStringField,
    readAskedQuestions,
    writeAskedQuestions,
    readPendingQuestions,
    appendPendingQuestions,
    clearPendingQuestions,
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
    commitPullState,
};
