/**
 * Live diary questioning service.
 *
 * Manages per-session state for the live diary pipeline in the temporary
 * LevelDB store.  All state is persisted — the backend is stateless and
 * can be rebooted without losing session progress.
 *
 * State is keyed under the shared audio session tree:
 *   audio_session/sessions/<sessionId>/live_diary/ → per-session live state fields
 *
 * Session lifecycle:
 *   - Live diary state is scoped by sessionId and processed asynchronously
 *     per session via queueing in the route layer.
 *   - Cross-session cleanup is intentionally not triggered from this async
 *     fragment-processing path to avoid stale in-flight fragments deleting
 *     state for a newer active session.
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
    validatePcmParams,
} = require("../audio_recording_session");
const { programmaticRecombination } = require("../ai");
const {
    LAST_FRAGMENT_FORMAT_KEY,
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
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
const { buildWav, extensionForMime } = require("./wav_utils");
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
 * @typedef {'ok' | 'empty_result' | 'degraded_transcription' | 'degraded_question_generation' | 'invalid_pcm'} PushAudioStatus
 */

/**
 * @typedef {object} PcmInfo
 * @property {Buffer} pcm - Raw PCM sample bytes (16-bit signed little-endian).
 * @property {number} sampleRateHz - Samples per second.
 * @property {number} channels - Number of audio channels.
 * @property {number} bitDepth - Bits per sample (must be 16).
 */

/**
 * @typedef {object} PushAudioResult
 * @property {Array<{text: string, intent: string}>} questions - Deduplicated new questions to ask.
 * @property {PushAudioStatus} status - Processing status:
 *   - `ok`: everything succeeded (questions may still be empty if the session is new or the AI found nothing new),
 *   - `empty_result`: first fragment — no window available yet,
 *   - `degraded_transcription`: transcription failed; questions array is empty,
 *   - `degraded_question_generation`: question generation failed; questions array is empty,
 *   - `invalid_pcm`: fragment PCM info is invalid (unsupported bitDepth or missing data).
 */

/**
 * Push a new nominal-10s PCM audio fragment for a session.
 *
 * On the first fragment the PCM is stored and an empty questions array is
 * returned (status `empty_result`) — there is not yet enough audio to form the
 * first 2-fragment overlap window.
 *
 * On every subsequent fragment:
 *  1. Binary-concatenates the stored PCM with the new one to form a 2-fragment window.
 *  2. Wraps the combined PCM in a WAV file for transcription.
 *  3. Transcribes that overlap window.
 *  4. LLM-recombines with the previous window transcript (with programmatic fallback).
 *  5. Accumulates the merged result into the running transcript.
 *  6. Generates diary questions from the running transcript.
 *  7. Returns deduplicated new questions.
 *
 * Fail-soft behavior is preserved: transcription and question-generation
 * failures do not throw to the caller.  Instead, the status field of the
 * returned object distinguishes a genuine empty result from a degraded one.
 *
 * All state (last PCM fragment, transcripts, asked questions) is persisted under
 * the shared audio_session keyspace so the backend can be rebooted without
 * losing session progress.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {PcmInfo} pcmInfo
 * @param {number} fragmentNumber
 * @param {number} [stepTimeoutMs]
 * @returns {Promise<PushAudioResult>}
 */
async function pushAudio(
    capabilities,
    sessionId,
    pcmInfo,
    fragmentNumber,
    stepTimeoutMs = DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS
) {
    const { temporary } = capabilities;
    const { pcm, sampleRateHz, channels, bitDepth } = pcmInfo;

    // Validate the full PcmInfo shape before touching any state.
    const pcmError = validatePcmParams(pcm, sampleRateHz, channels, bitDepth);
    if (pcmError !== null) {
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber, error: pcmError },
            "Live diary push-pcm rejected: invalid PCM parameters"
        );
        return { questions: [], status: "invalid_pcm" };
    }

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, chunkSizeBytes: pcm.length, sampleRateHz, channels, bitDepth },
        "Live diary received PCM chunk"
    );

    // Ensure session is registered.
    await markSessionExists(temporary, sessionId);

    const lastFragmentBuffer = await readLastFragment(temporary, sessionId);

    if (lastFragmentBuffer === null) {
        // First fragment: store the PCM and return no questions yet.
        await writeLastFragment(temporary, sessionId, pcm);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_FORMAT_KEY, `${sampleRateHz}/${channels}/${bitDepth}`);
        capabilities.logger.logDebug(
            { sessionId, fragmentNumber },
            "Live diary first PCM fragment stored; waiting for second fragment to form overlap window"
        );
        return { questions: [], status: "empty_result" };
    }

    // Parse the stored previous fragment metadata.
    const lastFragmentMeta = await readStringField(temporary, sessionId, LAST_FRAGMENT_FORMAT_KEY);
    const [prevSampleRateHz, prevChannels, prevBitDepth] = (lastFragmentMeta || "")
        .split("/")
        .map(Number);

    // Concatenate raw PCM bytes from the two fragments to form the 20-second overlap window.
    // Reject the window if the two fragments report different audio formats.
    if (
        prevSampleRateHz !== sampleRateHz ||
        prevChannels !== channels ||
        prevBitDepth !== bitDepth
    ) {
        capabilities.logger.logWarning(
            { sessionId, fragmentNumber },
            "Live diary PCM format mismatch between fragments; resetting with current fragment"
        );
        await writeLastFragment(temporary, sessionId, pcm);
        await writeStringField(temporary, sessionId, LAST_FRAGMENT_FORMAT_KEY, `${sampleRateHz}/${channels}/${bitDepth}`);
        return { questions: [], status: "degraded_transcription" };
    }

    const combinedPcm = Buffer.concat([lastFragmentBuffer, pcm]);
    // Wrap combined PCM in WAV for transcription API.
    const window20s = buildWav(combinedPcm, sampleRateHz, channels, bitDepth);

    capabilities.logger.logDebug(
        {
            sessionId,
            fragmentNumber,
            lastFragmentBytes: lastFragmentBuffer.length,
            currentFragmentBytes: pcm.length,
            combinedBytes: combinedPcm.length,
        },
        "Live diary forming 20s PCM overlap window for transcription"
    );

    // Advance the stored fragment to the current one for the next call.
    await writeLastFragment(temporary, sessionId, pcm);
    await writeStringField(temporary, sessionId, LAST_FRAGMENT_FORMAT_KEY, `${sampleRateHz}/${channels}/${bitDepth}`);

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

    const transcriptSuffix = updatedRunningTranscript.slice(-532);
    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, runningTranscriptLength: updatedRunningTranscript.length, suffix: transcriptSuffix },
        "Live diary running transcript updated (532-char suffix shown)"
    );

    // Compute how many questions to request based on transcript word count.
    // Default is 1 question (one per ~10-second fragment). Allow up to 5 for
    // content-rich fragments to give the user more reflection prompts.
    // If the window transcript has very few words the user is likely silent — skip.
    const wordCount = newWindowTranscript.split(/\s+/).filter(Boolean).length;
    /** @type {number} */
    let maxQuestions;
    if (wordCount < 10) {
        // Very sparse speech — skip question generation.
        capabilities.logger.logDebug(
            { sessionId, fragmentNumber, wordCount },
            "Live diary transcript too short for questions; skipping"
        );
        return { questions: [], status: "ok" };
    } else if (wordCount < 30) {
        maxQuestions = 1;
    } else if (wordCount < 60) {
        maxQuestions = 2;
    } else {
        maxQuestions = 5;
    }

    capabilities.logger.logDebug(
        { sessionId, fragmentNumber, wordCount, maxQuestions },
        "Live diary question count determined from word count"
    );

    // Generate questions.
    const askedQuestions = await readAskedQuestions(temporary, sessionId);
    let allQuestions;
    try {
        allQuestions = await withStepTimeout(
            "question_generation",
            () => capabilities.aiDiaryQuestions.generateQuestions(
                updatedRunningTranscript,
                askedQuestions,
                maxQuestions
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
