/**
 * Live diary questioning service.
 *
 * Manages per-session state for the live diary pipeline in the temporary
 * LevelDB store.  All state is persisted — the backend is stateless and
 * can be rebooted without losing session progress.
 *
 * State is keyed under the shared audio session tree:
 *   audio_session/index/current_session_id → tracks the active session
 *   audio_session/sessions/<sessionId>/live_diary/ → per-session live state fields
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
    markSessionExists,
    unmarkSessionExists,
    listKnownSessionIds,
    deleteSessionData,
} = require("../audio_recording_session");
const { programmaticRecombination } = require("../ai");
const {
    LAST_FRAGMENT_MIME_KEY,
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
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
} = require("./session_state");

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

/**
 * Normalize a MIME type to its lowercased base form (without parameters).
 * @param {string} mimeType
 * @returns {string}
 */
function normalizeMimeType(mimeType) {
    return (mimeType.split(";")[0] || "").trim().toLowerCase();
}

/**
 * Prepare a window transcript for recombination.
 *
 * When the transcript is not too short, remove the last word before
 * sending it to the recombination model (to avoid anchoring on a likely
 * unstable boundary token), then append that removed word back after
 * recombination.
 *
 * @param {string} transcript
 * @returns {{ textForRecombination: string, removedTailWord: string }}
 */
function prepareTranscriptForRecombination(transcript) {
    const trimmed = transcript.trim();
    if (!trimmed) {
        return { textForRecombination: transcript, removedTailWord: "" };
    }

    const words = trimmed.split(/\s+/u);
    const tooFewWords = words.length < 2;
    const removedTailWord = words.pop() || "";
    const tooFewCharsInInitialWords = words.join("").length < 4;
    if (tooFewWords || tooFewCharsInInitialWords) {
        return { textForRecombination: transcript, removedTailWord: "" };
    }

    return {
        textForRecombination: words.join(" "),
        removedTailWord,
    };
}

/**
 * Append a removed tail word to recombination output.
 * @param {string} recombinedText
 * @param {string} removedTailWord
 * @returns {string}
 */
function appendRemovedTailWord(recombinedText, removedTailWord) {
    if (!removedTailWord) {
        return recombinedText;
    }

    const trimmed = recombinedText.trim();
    if (!trimmed) {
        return removedTailWord;
    }

    return `${trimmed} ${removedTailWord}`;
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
 * @typedef {'ok' | 'empty_result' | 'degraded_transcription' | 'degraded_question_generation' | 'unsupported_mime'} PushAudioStatus
 */

/**
 * @typedef {object} PushAudioResult
 * @property {Array<{text: string, intent: string}>} questions - Deduplicated new questions to ask.
 * @property {PushAudioStatus} status - Processing status:
 *   - `ok`: everything succeeded (questions may still be empty if the session is new or the AI found nothing new),
 *   - `empty_result`: first fragment — no window available yet,
 *   - `degraded_transcription`: transcription failed; questions array is empty,
 *   - `degraded_question_generation`: question generation failed; questions array is empty,
 *   - `unsupported_mime`: mime type is not supported for safe window assembly.
 */

/**
 * Push a new nominal-10s audio fragment for a session.
 *
 * On the first fragment the audio is stored and an empty questions array is
 * returned (status `empty_result`) — there is not yet enough audio to form the
 * first 2-fragment overlap window.
 *
 * On every subsequent fragment:
 *  1. Binary-concatenates the stored fragment with the new one to form a 2-fragment window.
 *  2. Transcribes that overlap window.
 *  3. LLM-recombines with the previous window transcript (with programmatic fallback).
 *  4. Accumulates the merged result into the running transcript.
 *  5. Generates diary questions from the running transcript.
 *  6. Returns deduplicated new questions.
 *
 * Fail-soft behavior is preserved: transcription and question-generation
 * failures do not throw to the caller.  Instead, the status field of the
 * returned object distinguishes a genuine empty result from a degraded one.
 *
 * All state (last fragment, transcripts, asked questions) is persisted under
 * the shared audio_session keyspace so the backend can be rebooted without
 * losing session progress.
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
    const normalizedMimeType = normalizeMimeType(mimeType);

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, chunkSizeBytes: fragmentBuffer.length, mimeType: normalizedMimeType },
        "Live diary received audio chunk"
    );

    // Ensure session is registered and clean up any old sessions.
    await cleanupOldSessionsIfNeeded(temporary, sessionId);

    const lastFragment = await readLastFragment(temporary, sessionId);

    if (lastFragment === null) {
        // First fragment: store it and return no questions yet.
        await writeLastFragment(temporary, sessionId, fragmentBuffer);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, normalizedMimeType);
        capabilities.logger.logDebug(
            { sessionId, fragmentNumber },
            "Live diary first fragment stored; waiting for second fragment to form overlap window"
        );
        return { questions: [], status: "empty_result" };
    }

    if (normalizedMimeType !== "audio/webm") {
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber, mimeType: normalizedMimeType },
            "Live diary push-audio rejected unsupported mime type for safe window assembly"
        );
        return { questions: [], status: "unsupported_mime" };
    }

    // We have the previous fragment plus the current one: form an overlap window.
    // See the note in audio_recording_session/service.js: this concatenation is safe
    // only for audio/webm (streaming Matroska).  The frontend is required to record
    // in audio/webm for this invariant to hold.
    const window20s = Buffer.concat([lastFragment, fragmentBuffer]);

    capabilities.logger.logDebug(
        {
            sessionId,
            fragmentNumber,
            previousFragmentSizeBytes: lastFragment.length,
            currentFragmentSizeBytes: fragmentBuffer.length,
            windowSizeBytes: window20s.length,
        },
        "Live diary forming 20s overlap window for transcription"
    );

    // Advance the stored fragment to the current one for the next call.
    await writeLastFragment(temporary, sessionId, fragmentBuffer);
    await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, normalizedMimeType);

    // Transcribe the overlap window.
    let newWindowTranscript;
    try {
        newWindowTranscript = await transcribeBuffer(window20s, normalizedMimeType, capabilities);
    } catch (error) {
        capabilities.logger.logError(
            { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
            "Live diary transcription failed"
        );
        return { questions: [], status: "degraded_transcription" };
    }

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, transcriptLength: newWindowTranscript.length, transcript: newWindowTranscript },
        "Live diary overlap window transcription result"
    );

    if (!newWindowTranscript) {
        // Silent audio — nothing to recombine or question.
        capabilities.logger.logDebug(
            { sessionId, fragmentNumber },
            "Live diary overlap window transcript is empty (silent audio); skipping recombination and questions"
        );
        return { questions: [], status: "ok" };
    }

    // LLM-recombine with the previous window transcript (with programmatic fallback).
    const lastWindowTranscript = await readStringField(
        temporary, sessionId, LAST_WINDOW_TRANSCRIPT_KEY
    );

    let merged;
    if (lastWindowTranscript) {
        const prepared = prepareTranscriptForRecombination(newWindowTranscript);
        capabilities.logger.logDebug(
            {
                sessionId,
                fragmentNumber,
                lastWindowTranscriptLength: lastWindowTranscript.length,
                newWindowTranscriptForRecombinationLength: prepared.textForRecombination.length,
                removedTailWord: prepared.removedTailWord,
            },
            "Live diary attempting LLM recombination of overlap window transcripts"
        );
        try {
            merged = await capabilities.aiTranscriptRecombination.recombineOverlap(
                lastWindowTranscript,
                prepared.textForRecombination
            );
            merged = appendRemovedTailWord(merged, prepared.removedTailWord);
            capabilities.logger.logDebug(
                { sessionId, fragmentNumber, mergedLength: merged.length, merged },
                "Live diary LLM recombination succeeded"
            );
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
                "Live diary recombination failed; using new window transcript directly"
            );
            merged = newWindowTranscript;
        }
    } else {
        merged = newWindowTranscript;
        capabilities.logger.logDebug(
            { sessionId, fragmentNumber },
            "Live diary no previous window transcript; using new window transcript directly"
        );
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

    const transcriptSuffix = updatedRunningTranscript.slice(-200);
    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, runningTranscriptLength: updatedRunningTranscript.length, suffix: transcriptSuffix },
        "Live diary running transcript updated (200-char suffix shown)"
    );

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
            { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
            "Live diary question generation failed"
        );
        return { questions: [], status: "degraded_question_generation" };
    }

    const newQuestions = deduplicateQuestions(allQuestions, askedQuestions);

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, newQuestionsCount: newQuestions.length, totalAskedCount: askedQuestions.length },
        "Live diary question generation result"
    );

    if (newQuestions.length > 0) {
        await writeAskedQuestions(temporary, sessionId, [
            ...askedQuestions,
            ...newQuestions.map((q) => q.text),
        ]);
        await appendPendingQuestions(temporary, sessionId, newQuestions);
    }

    return { questions: newQuestions, status: "ok" };
}

/**
 * Fetch and clear pending live diary questions for a session.
 *
 * Returns all questions that have been generated since the last call.
 * The pending list is cleared atomically so each question is returned at most once.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<Array<{text: string, intent: string}>>}
 */
async function getPendingQuestions(capabilities, sessionId) {
    const { temporary } = capabilities;
    const questions = await readPendingQuestions(temporary, sessionId);
    if (questions.length > 0) {
        await clearPendingQuestions(temporary, sessionId);
        capabilities.logger.logDebug(
            { sessionId, count: questions.length },
            "Live diary pending questions fetched and cleared"
        );
    }
    return questions;
}

module.exports = {
    pushAudio,
    getPendingQuestions,
};
