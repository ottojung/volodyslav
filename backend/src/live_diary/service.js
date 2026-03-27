/**
 * Live diary questioning service.
 *
 * Manages per-session state for the live diary pipeline in the temporary
 * LevelDB store.  All state is persisted — the backend is stateless and
 * can be rebooted without losing session progress.
 *
 * State is keyed under:
 *   live_diary/index/current_session_id → tracks the active session
 *   live_diary/sessions/<sessionId>/    → per-session state fields
 *
 * Session lifecycle:
 *   - The first pushAudio call for a new sessionId triggers cleanup of any
 *     previous live diary session before recording new state.
 *   - Only one live diary session is "current" at a time; all others are
 *     cleaned up automatically.
 *
 * @module live_diary/service
 */

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const fs = require("fs");
const crypto = require("crypto");
const {
    CURRENT_SESSION_KEY,
    LAST_FRAGMENT_KEY,
    LAST_FRAGMENT_MIME_KEY,
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
    ASKED_QUESTIONS_KEY,
    indexSublevel,
    sessionSublevel,
    markSessionExists,
    unmarkSessionExists,
    listKnownSessionIds,
    deleteSessionData,
} = require("./keys");
const { programmaticRecombination } = require("../ai");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */
/** @typedef {import('../temporary/database/types').LiveDiaryQuestion} LiveDiaryQuestion */

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 */

/** Supported audio MIME types and their extensions. */
/** @type {Record<string, string>} */
const EXTENSION_BY_MIME = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/flac": "flac",
};

/**
 * Returns the file extension for a MIME type, defaulting to "webm".
 * @param {string} mimeType
 * @returns {string}
 */
function extensionForMime(mimeType) {
    const base = (mimeType.split(";")[0] || "").trim().toLowerCase();
    return EXTENSION_BY_MIME[base] || "webm";
}

// ---------------------------------------------------------------------------
// Low-level DB accessors
// ---------------------------------------------------------------------------

/**
 * Read the current session id from the index.
 * Returns null if not set.
 * @param {Temporary} temporary
 * @returns {Promise<string | null>}
 */
async function readCurrentSessionId(temporary) {
    const entry = await indexSublevel(temporary).get(CURRENT_SESSION_KEY);
    if (entry === undefined || entry.type !== "live_diary_index") {
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
        type: "live_diary_index",
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
    const entry = await sessionSublevel(temporary, sessionId).get(LAST_FRAGMENT_KEY);
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
    await sessionSublevel(temporary, sessionId).put(LAST_FRAGMENT_KEY, {
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
    const entry = await sessionSublevel(temporary, sessionId).get(key);
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
    await sessionSublevel(temporary, sessionId).put(key, {
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
    const entry = await sessionSublevel(temporary, sessionId).get(ASKED_QUESTIONS_KEY);
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
    await sessionSublevel(temporary, sessionId).put(ASKED_QUESTIONS_KEY, {
        type: "live_diary_questions",
        questions: questions.map((text) => ({ text, intent: "" })),
    });
}

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Delete all live diary data for sessions other than the given sessionId.
 * Short-circuits when the given session is already the current one.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function cleanupOldSessionsIfNeeded(temporary, sessionId) {
    const currentId = await readCurrentSessionId(temporary);
    if (currentId === sessionId) {
        return; // Already current — nothing to clean up.
    }

    const sessionIds = await listKnownSessionIds(temporary);
    for (const id of sessionIds) {
        if (id !== sessionId) {
            await deleteSessionData(temporary, id);
            await unmarkSessionExists(temporary, id);
        }
    }
    await writeCurrentSessionId(temporary, sessionId);
    await markSessionExists(temporary, sessionId);
}

// ---------------------------------------------------------------------------
// Transcription helper
// ---------------------------------------------------------------------------

/**
 * Write a Buffer to a named temp file, transcribe it, then delete the temp file.
 * Returns the raw transcript string (trimmed).
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {Capabilities} capabilities
 * @returns {Promise<string>}
 */
async function transcribeBuffer(audioBuffer, mimeType, capabilities) {
    const ext = extensionForMime(mimeType);
    const randomHex = crypto.randomBytes(8).toString("hex");
    const tmpFile = path.join(os.tmpdir(), `diary-live-${randomHex}.${ext}`);

    try {
        await fsp.writeFile(tmpFile, audioBuffer);

        const fileStream = fs.createReadStream(tmpFile);

        // Wait for the file to be opened before calling the transcription service.
        await new Promise((resolve, reject) => {
            fileStream.once("open", resolve);
            fileStream.once("error", reject);
        });

        let result;
        try {
            result = await capabilities.aiTranscription.transcribeStreamDetailed(fileStream);
        } finally {
            fileStream.destroy();
        }

        return result.structured.transcript.trim();
    } finally {
        fsp.unlink(tmpFile).catch(() => {
            // Best-effort cleanup.
        });
    }
}

// ---------------------------------------------------------------------------
// Question deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate questions by normalised text, keeping the first occurrence.
 *
 * Normalisation is Unicode-aware: it uses NFKD decomposition, lowercasing,
 * Unicode-category punctuation/symbol removal, and whitespace collapsing.
 * This ensures correct deduplication for non-Latin scripts such as Cyrillic.
 *
 * @param {Array<{text: string, intent: string}>} questions
 * @param {string[]} askedTexts
 * @returns {Array<{text: string, intent: string}>}
 */
function deduplicateQuestions(questions, askedTexts) {
    const normalise = (/** @type {string} */ s) =>
        s.normalize("NFKD")
         .toLowerCase()
         .replace(/[\p{P}\p{S}]/gu, "")
         .replace(/\s+/g, " ")
         .trim();

    const seen = new Set(askedTexts.map(normalise));
    /** @type {Array<{text: string, intent: string}>} */
    const result = [];
    for (const q of questions) {
        const key = normalise(q.text);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(q);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Public service function
// ---------------------------------------------------------------------------

/**
 * @typedef {'ok' | 'empty_result' | 'degraded_transcription' | 'degraded_question_generation'} PushAudioStatus
 */

/**
 * @typedef {object} PushAudioResult
 * @property {Array<{text: string, intent: string}>} questions - Deduplicated new questions to ask.
 * @property {PushAudioStatus} status - Processing status:
 *   - `ok`: everything succeeded (questions may still be empty if the session is new or the AI found nothing new),
 *   - `empty_result`: first fragment — no window available yet,
 *   - `degraded_transcription`: transcription failed; questions array is empty,
 *   - `degraded_question_generation`: question generation failed; questions array is empty.
 */

/**
 * Push a new 10-second audio fragment for a session.
 *
 * On the first fragment the audio is stored and an empty questions array is
 * returned (status `empty_result`) — there is not yet enough audio to form a
 * 20-second window.
 *
 * On every subsequent fragment:
 *  1. Binary-concatenates the stored fragment with the new one to form a 20s window.
 *  2. Transcribes the 20s window.
 *  3. LLM-recombines with the previous window transcript (with programmatic fallback).
 *  4. Accumulates the merged result into the running transcript.
 *  5. Generates diary questions from the running transcript.
 *  6. Returns deduplicated new questions.
 *
 * Fail-soft behavior is preserved: transcription and question-generation
 * failures do not throw to the caller.  Instead, the status field of the
 * returned object distinguishes a genuine empty result from a degraded one.
 *
 * All state (last fragment, transcripts, asked questions) is persisted to the
 * temporary LevelDB database so the backend can be rebooted without losing
 * session progress.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {Buffer} fragmentBuffer
 * @param {string} mimeType
 * @param {number} fragmentNumber
 * @returns {Promise<PushAudioResult>}
 */
async function pushAudio(capabilities, sessionId, fragmentBuffer, mimeType, fragmentNumber) {
    const { temporary } = capabilities;

    // Ensure session is registered and clean up any old sessions.
    await cleanupOldSessionsIfNeeded(temporary, sessionId);

    const lastFragment = await readLastFragment(temporary, sessionId);

    if (lastFragment === null) {
        // First fragment: store it and return no questions yet.
        await writeLastFragment(temporary, sessionId, fragmentBuffer);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, mimeType);
        return { questions: [], status: "empty_result" };
    }

    // We have the previous fragment plus the current one: form a ~20s window.
    // See the note in audio_recording_session/service.js: this concatenation is safe
    // only for audio/webm (streaming Matroska).  The frontend is required to record
    // in audio/webm for this invariant to hold.
    const window20s = Buffer.concat([lastFragment, fragmentBuffer]);

    // Advance the stored fragment to the current one for the next call.
    await writeLastFragment(temporary, sessionId, fragmentBuffer);
    await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, mimeType);

    // Transcribe the 20-second window.
    let newWindowTranscript;
    try {
        newWindowTranscript = await transcribeBuffer(window20s, mimeType, capabilities);
    } catch (error) {
        capabilities.logger.logError(
            { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
            "Live diary transcription failed"
        );
        return { questions: [], status: "degraded_transcription" };
    }

    if (!newWindowTranscript) {
        // Silent audio — nothing to recombine or question.
        return { questions: [], status: "ok" };
    }

    // LLM-recombine with the previous window transcript (with programmatic fallback).
    const lastWindowTranscript = await readStringField(
        temporary, sessionId, LAST_WINDOW_TRANSCRIPT_KEY
    );

    let merged;
    if (lastWindowTranscript) {
        try {
            merged = await capabilities.aiTranscriptRecombination.recombineOverlap(
                lastWindowTranscript,
                newWindowTranscript
            );
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Live diary recombination failed; using new window transcript directly"
            );
            merged = newWindowTranscript;
        }
    } else {
        merged = newWindowTranscript;
    }

    await writeStringField(temporary, sessionId, LAST_WINDOW_TRANSCRIPT_KEY, newWindowTranscript);

    // Accumulate into running transcript, deduplicating the boundary.
    const runningTranscript = await readStringField(
        temporary, sessionId, RUNNING_TRANSCRIPT_KEY
    );
    const updatedRunningTranscript = runningTranscript
        ? programmaticRecombination(runningTranscript, merged)
        : merged;

    await writeStringField(temporary, sessionId, RUNNING_TRANSCRIPT_KEY, updatedRunningTranscript);

    // Generate questions.
    const askedQuestions = await readAskedQuestions(temporary, sessionId);
    let allQuestions;
    try {
        allQuestions = await capabilities.aiDiaryQuestions.generateQuestions(
            updatedRunningTranscript,
            askedQuestions
        );
    } catch (error) {
        capabilities.logger.logError(
            { sessionId, error: error instanceof Error ? error.message : String(error) },
            "Live diary question generation failed"
        );
        return { questions: [], status: "degraded_question_generation" };
    }

    const newQuestions = deduplicateQuestions(allQuestions, askedQuestions);

    if (newQuestions.length > 0) {
        await writeAskedQuestions(temporary, sessionId, [
            ...askedQuestions,
            ...newQuestions.map((q) => q.text),
        ]);
    }

    return { questions: newQuestions, status: "ok" };
}

module.exports = {
    pushAudio,
};
