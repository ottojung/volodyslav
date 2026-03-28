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
const { parseWav, buildWav, extensionForMime, normalizeMimeType } = require("./wav_utils");
const {
    DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS,
    isLiveDiaryStepTimeoutError,
    withStepTimeout,
} = require("./step_timeout");
const {
    prepareTranscriptForRecombination,
    appendRemovedTailWord,
    deduplicateQuestions,
} = require("./text_processing");

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
            result = await capabilities.aiTranscription.transcribeStreamPreciseDetailed(fileStream);
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

// ---------------------------------------------------------------------------
// Public service function
// ---------------------------------------------------------------------------

/**
 * @typedef {'ok' | 'empty_result' | 'degraded_transcription' | 'degraded_question_generation' | 'unsupported_mime' | 'invalid_wav'} PushAudioStatus
 */

/**
 * @typedef {object} PushAudioResult
 * @property {Array<{text: string, intent: string}>} questions - Deduplicated new questions to ask.
 * @property {PushAudioStatus} status - Processing status:
 *   - `ok`: everything succeeded (questions may still be empty if the session is new or the AI found nothing new),
 *   - `empty_result`: first fragment — no window available yet,
 *   - `degraded_transcription`: transcription failed; questions array is empty,
 *   - `degraded_question_generation`: question generation failed; questions array is empty,
 *   - `unsupported_mime`: mime type is not audio/wav,
 *   - `invalid_wav`: fragment buffer could not be parsed as a valid 16-bit PCM WAV file.
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
 * @param {number} [stepTimeoutMs]
 * @returns {Promise<PushAudioResult>}
 */
async function pushAudio(
    capabilities,
    sessionId,
    fragmentBuffer,
    mimeType,
    fragmentNumber,
    stepTimeoutMs = DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS
) {
    const { temporary } = capabilities;
    const normalizedMimeType = normalizeMimeType(mimeType);

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, chunkSizeBytes: fragmentBuffer.length, mimeType: normalizedMimeType },
        "Live diary received audio chunk"
    );

    // Ensure session is registered and clean up any old sessions.
    await cleanupOldSessionsIfNeeded(temporary, sessionId);

    // Live diary requires WAV-wrapped PCM for safe sample-level concatenation.
    if (normalizedMimeType !== "audio/wav") {
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber, mimeType: normalizedMimeType },
            "Live diary push-audio rejected unsupported mime type; audio/wav required"
        );
        return { questions: [], status: "unsupported_mime" };
    }

    const currentWavInfo = parseWav(fragmentBuffer);
    if (!currentWavInfo) {
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber, fragmentSizeBytes: fragmentBuffer.length },
            "Live diary push-audio rejected malformed WAV buffer"
        );
        return { questions: [], status: "invalid_wav" };
    }

    const lastFragment = await readLastFragment(temporary, sessionId);

    if (lastFragment === null) {
        // First fragment: store the full WAV buffer and return no questions yet.
        await writeLastFragment(temporary, sessionId, fragmentBuffer);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, normalizedMimeType);
        capabilities.logger.logDebug(
            { sessionId, fragmentNumber },
            "Live diary first WAV fragment stored; waiting for second fragment to form overlap window"
        );
        return { questions: [], status: "empty_result" };
    }

    // Parse the stored previous WAV fragment to extract its PCM payload.
    const prevWavInfo = parseWav(lastFragment);
    if (!prevWavInfo) {
        // Previous fragment is corrupt; reset with the current one and skip this window.
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber },
            "Live diary stored fragment is corrupt; resetting with current fragment"
        );
        await writeLastFragment(temporary, sessionId, fragmentBuffer);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, normalizedMimeType);
        return { questions: [], status: "degraded_transcription" };
    }

    // Concatenate raw PCM bytes from the two fragments to form the 20-second overlap window.
    // PCM concatenation is structurally safe because sample boundaries are explicit.
    // Reject the window if the two fragments report different audio formats — concatenating
    // PCM from mismatched streams would produce corrupt audio.
    if (
        prevWavInfo.sampleRate !== currentWavInfo.sampleRate ||
        prevWavInfo.channels !== currentWavInfo.channels ||
        prevWavInfo.bitDepth !== currentWavInfo.bitDepth
    ) {
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber },
            "Live diary PCM format mismatch between fragments; resetting with current fragment"
        );
        await writeLastFragment(temporary, sessionId, fragmentBuffer);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, normalizedMimeType);
        return { questions: [], status: "degraded_transcription" };
    }
    const combinedPcm = Buffer.concat([prevWavInfo.pcm, currentWavInfo.pcm]);
    const window20s = buildWav(
        combinedPcm,
        currentWavInfo.sampleRate,
        currentWavInfo.channels,
        currentWavInfo.bitDepth
    );

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber },
        "Live diary forming 20s PCM overlap window for transcription"
    );

    // Advance the stored fragment to the current one for the next call.
    await writeLastFragment(temporary, sessionId, fragmentBuffer);
    await writeStringField(temporary, sessionId, LAST_FRAGMENT_MIME_KEY, normalizedMimeType);

    // Transcribe the overlap window (always audio/wav — built from PCM above).
    let newWindowTranscript;
    try {
        newWindowTranscript = await withStepTimeout(
            "transcription",
            () => transcribeBuffer(window20s, "audio/wav", capabilities),
            stepTimeoutMs
        );
    } catch (error) {
        if (isLiveDiaryStepTimeoutError(error)) {
            capabilities.logger.logWarning(
                { sessionId, fragmentNumber, timeoutMs: error.timeoutMs, step: error.step },
                "Live diary transcription timed out; skipping this fragment"
            );
        } else {
            capabilities.logger.logError(
                { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
                "Live diary transcription failed"
            );
        }
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
            merged = await withStepTimeout(
                "recombination",
                () => capabilities.aiTranscriptRecombination.recombineOverlap(
                    lastWindowTranscript,
                    prepared.textForRecombination
                ),
                stepTimeoutMs
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
        allQuestions = await withStepTimeout(
            "question_generation",
            () => capabilities.aiDiaryQuestions.generateQuestions(
                updatedRunningTranscript,
                askedQuestions
            ),
            stepTimeoutMs
        );
    } catch (error) {
        if (isLiveDiaryStepTimeoutError(error)) {
            capabilities.logger.logWarning(
                { sessionId, fragmentNumber, timeoutMs: error.timeoutMs, step: error.step },
                "Live diary question generation timed out; skipping this fragment"
            );
        } else {
            capabilities.logger.logError(
                { sessionId, fragmentNumber, error: error instanceof Error ? error.message : String(error) },
                "Live diary question generation failed"
            );
        }
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
