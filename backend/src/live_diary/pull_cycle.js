/**
 * Internal pull cycle implementation for the cadence-agnostic live diary pipeline.
 *
 * Contains the core `_runPullCycle` function.
 * I/O helpers (`transcribeBuffer`, `loadFragmentPcm`) live in `pull_helpers.js`.
 *
 * This module is package-private: it must only be imported by `pull_service.js`.
 *
 * @module live_diary/pull_cycle
 */

const { programmaticRecombination } = require("../ai");
const {
    LAST_WINDOW_TRANSCRIPT_KEY,
    RUNNING_TRANSCRIPT_KEY,
    WORDS_SINCE_LAST_QUESTION_KEY,
    readStringField,
    readAskedQuestions,
    readPendingQuestions,
    commitPullState,
    listFragmentIndex,
    readTranscribedUntilMs,
    readLastTranscribedRange,
    readKnownGaps,
    writeKnownGaps,
} = require("./session_state");
const { buildWav } = require("./wav_utils");
const { assemblePcm } = require("./assembler");
const { scanGaps } = require("./gap_tracker");
const {
    isLiveDiaryStepTimeoutError,
    withStepTimeout,
} = require("./step_timeout");
const {
    prepareTranscriptForRecombination,
    appendRemovedTailWord,
    deduplicateQuestions,
} = require("./text_processing");
const { transcribeBuffer, loadFragmentPcm } = require("./pull_helpers");
const { planWindowWithCaps } = require("./pull_window_planning");
const { computeNewLastRange } = require("./last_transcribed_range");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {FileDeleter} deleter
 */

/**
 * @typedef {'ok' | 'no_candidates' | 'blocked_at_watermark'
 *   | 'degraded_transcription' | 'degraded_question_generation'} PullStatus
 */

/**
 * @typedef {object} PullResult
 * @property {PullStatus} status
 * @property {boolean} [degradedGap] - True when at least one abandoned gap was crossed.
 */

// ---------------------------------------------------------------------------
// Main pull cycle
// ---------------------------------------------------------------------------

/**
 * Internal pull cycle implementation.
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {number} deadlineMs
 * @param {number} nowMs
 * @param {number} stepTimeoutMs
 * @returns {Promise<PullResult>}
 */
async function _runPullCycle(capabilities, sessionId, deadlineMs, nowMs, stepTimeoutMs) {
    const { temporary } = capabilities;

    // 2. Read watermark and fragment index.
    const transcribedUntilMs = await readTranscribedUntilMs(temporary, sessionId);
    const allFragments = await listFragmentIndex(temporary, sessionId);

    // 3. Identify candidates: fragments intersecting (transcribedUntilMs, deadlineMs].
    const candidates = allFragments.filter((f) => f.endMs > transcribedUntilMs && f.startMs < deadlineMs);

    if (candidates.length === 0) {
        capabilities.logger.logDebug(
            { sessionId, transcribedUntilMs, deadlineMs },
            "Pull cycle: no candidate fragments — nothing to process"
        );
        return { status: "no_candidates" };
    }

    // 4. Determine processable range via gap tracker.
    const knownGaps = await readKnownGaps(temporary, sessionId);
    const gapScan = scanGaps({
        fragments: allFragments,
        transcribedUntilMs,
        deadlineMs,
        knownGaps,
        nowMs,
    });

    if (gapScan.blockedAtWatermark) {
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        capabilities.logger.logDebug(
            { sessionId, transcribedUntilMs, deadlineMs },
            "Pull cycle: blocked at watermark by waiting gap"
        );
        return { status: "blocked_at_watermark" };
    }

    const processableEndMs = gapScan.processableEndMs;

    if (processableEndMs <= transcribedUntilMs) {
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        capabilities.logger.logDebug(
            { sessionId, transcribedUntilMs, processableEndMs },
            "Pull cycle: processable range is empty — nothing to advance"
        );
        return { status: "no_candidates" };
    }

    // 5. Plan the transcription window (overlap).
    const lastRange = await readLastTranscribedRange(temporary, sessionId);
    const prevNewDurationMs = lastRange !== null
        ? lastRange.lastEndMs - lastRange.firstStartMs
        : null;

    const windowPlan = planWindowWithCaps({
        transcribedUntilMs,
        processableEndMs,
        prevNewDurationMs,
        candidates,
    });
    if (windowPlan === null) {
        return { status: "no_candidates" };
    }
    const {
        windowStartMs,
        plannedWindowEndMs,
        committedThroughMs,
        effectiveOverlapMs,
        sampleRateHz,
        channels,
        bitDepth,
    } = windowPlan;

    capabilities.logger.logDebug(
        {
            sessionId,
            transcribedUntilMs,
            processableEndMs,
            windowStartMs,
            plannedWindowEndMs,
            committedThroughMs,
            effectiveOverlapMs,
            hasDegradedGap: gapScan.hasDegradedGap,
        },
        "Pull cycle: window planned"
    );

    if (committedThroughMs <= transcribedUntilMs) {
        capabilities.logger.logWarning(
            { sessionId, transcribedUntilMs, windowStartMs, plannedWindowEndMs, committedThroughMs },
            "Pull cycle: capped window does not include new audio; skipping cycle"
        );
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        return { status: "degraded_transcription" };
    }

    // 6. Assemble PCM for [windowStartMs, committedThroughMs].

    /** @type {import('./assembler').AssemblerFragment[]} */
    const assemblerFragments = [];
    let hasMissingBinaryInWindow = false;
    for (const frag of allFragments) {
        if (frag.endMs <= windowStartMs || frag.startMs >= committedThroughMs) continue;
        const pcm = await loadFragmentPcm(temporary, sessionId, frag.sequence);
        if (pcm === null) {
            hasMissingBinaryInWindow = true;
            capabilities.logger.logWarning({ sessionId, sequence: frag.sequence, fragmentStartMs: frag.startMs, fragmentEndMs: frag.endMs, windowStartMs, committedThroughMs }, "Pull cycle: binary PCM missing for fragment in planned window — blocking watermark advance for this cycle");
            continue;
        }
        assemblerFragments.push({ ...frag, pcm });
    }

    if (hasMissingBinaryInWindow) {
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        return { status: "degraded_transcription" };
    }

    let combinedPcm;
    try {
        combinedPcm = assemblePcm({
            fragments: assemblerFragments,
            windowStartMs,
            windowEndMs: committedThroughMs,
            sampleRateHz,
            channels,
            bitDepth,
        });
    } catch (assemblerError) {
        capabilities.logger.logError(
            {
                sessionId,
                error: assemblerError instanceof Error ? assemblerError.message : String(assemblerError),
            },
            "Pull cycle: PCM assembly failed"
        );
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        return { status: "degraded_transcription" };
    }

    const windowWav = buildWav(combinedPcm, sampleRateHz, channels, bitDepth);

    // 7. Transcribe.
    let newWindowTranscript;
    try {
        newWindowTranscript = await withStepTimeout(
            "transcription",
            (signal) => transcribeBuffer(windowWav, "audio/wav", capabilities, signal),
            stepTimeoutMs
        );
    } catch (error) {
        if (isLiveDiaryStepTimeoutError(error)) {
            capabilities.logger.logWarning(
                { sessionId, timeoutMs: error.timeoutMs, step: error.step },
                "Pull cycle: transcription timed out"
            );
        } else {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Pull cycle: transcription failed"
            );
        }
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        return { status: "degraded_transcription" };
    }

    capabilities.logger.logDebug(
        { sessionId, transcriptLength: newWindowTranscript.length, windowStartMs, committedThroughMs },
        "Pull cycle: transcription result"
    );

    // Compute the new last-range metadata (clamped to the actual new region).
    const newLastRange = computeNewLastRange(candidates, transcribedUntilMs, committedThroughMs);

    if (!newWindowTranscript) {
        // Silent window — commit watermark + gaps but preserve transcript state.
        const existingLastWindowTranscript = await readStringField(temporary, sessionId, LAST_WINDOW_TRANSCRIPT_KEY);
        const existingRunning = await readStringField(temporary, sessionId, RUNNING_TRANSCRIPT_KEY);
        const existingWordCount = await readStringField(temporary, sessionId, WORDS_SINCE_LAST_QUESTION_KEY);
        await commitPullState(temporary, sessionId, {
            transcribedUntilMs: committedThroughMs,
            knownGaps: gapScan.updatedGaps,
            lastRange: newLastRange,
            lastWindowTranscript: existingLastWindowTranscript,
            runningTranscript: existingRunning,
            wordsSinceLastQuestion: parseInt(existingWordCount, 10) || 0,
            questionCommit: null,
        });
        capabilities.logger.logDebug(
            { sessionId },
            "Pull cycle: silent window — watermark advanced without transcript update"
        );
        return { status: "ok", degradedGap: gapScan.hasDegradedGap };
    }

    // 8. LLM-recombine with the previous window transcript.
    const lastWindowTranscript = await readStringField(
        temporary, sessionId, LAST_WINDOW_TRANSCRIPT_KEY
    );

    let merged;
    if (lastWindowTranscript) {
        const prepared = prepareTranscriptForRecombination(newWindowTranscript);
        // recombineOverlap never throws — each attempt is bounded by its own
        // internal per-call timeout, and all failures fall back to programmatic
        // recombination.  No outer withStepTimeout is needed here.
        merged = await capabilities.aiTranscriptRecombination.recombineOverlap(
            lastWindowTranscript,
            prepared.textForRecombination
        );
        merged = appendRemovedTailWord(merged, prepared.removedTailWord);
    } else {
        merged = newWindowTranscript;
    }

    // 9. Accumulate running transcript.
    const runningTranscript = await readStringField(
        temporary, sessionId, RUNNING_TRANSCRIPT_KEY
    );
    const updatedRunningTranscript = runningTranscript
        ? programmaticRecombination(runningTranscript, merged)
        : merged;

    // 10. Word count and question generation.
    const newTranscriptPortion =
        runningTranscript && updatedRunningTranscript.startsWith(runningTranscript)
            ? updatedRunningTranscript.slice(runningTranscript.length)
            : merged;
    const fragmentWordCount = newTranscriptPortion.split(/\s+/).filter(Boolean).length;
    const cumulativeWordCount = (parseInt(await readStringField(temporary, sessionId, WORDS_SINCE_LAST_QUESTION_KEY), 10) || 0) + fragmentWordCount;

    /** @type {import('./session_state').PullStateCommit} */
    const baseBundle = {
        transcribedUntilMs: committedThroughMs,
        knownGaps: gapScan.updatedGaps,
        lastRange: newLastRange,
        lastWindowTranscript: newWindowTranscript,
        runningTranscript: updatedRunningTranscript,
        wordsSinceLastQuestion: cumulativeWordCount,
        questionCommit: null,
    };

    if (cumulativeWordCount < 10) {
        await commitPullState(temporary, sessionId, baseBundle);
        capabilities.logger.logDebug(
            { sessionId, cumulativeWordCount },
            "Pull cycle: word count below threshold; skipping question generation"
        );
        return { status: "ok", degradedGap: gapScan.hasDegradedGap };
    }

    const existingPending = await readPendingQuestions(temporary, sessionId);
    if (existingPending.length > 0) {
        await commitPullState(temporary, sessionId, baseBundle);
        capabilities.logger.logDebug(
            { sessionId, pendingCount: existingPending.length },
            "Pull cycle: skipping question generation — previous batch not yet fetched"
        );
        return { status: "ok", degradedGap: gapScan.hasDegradedGap };
    }

    const maxQuestions = cumulativeWordCount < 30 ? 1 : cumulativeWordCount < 60 ? 2 : 5;

    const askedQuestions = await readAskedQuestions(temporary, sessionId);
    let allQuestions;
    try {
        allQuestions = await withStepTimeout(
            "question_generation",
            (_signal) => capabilities.aiDiaryQuestions.generateQuestions(
                updatedRunningTranscript,
                askedQuestions,
                maxQuestions
            ),
            stepTimeoutMs
        );
    } catch (error) {
        // Do NOT advance the watermark on question generation failure so the
        // next pull cycle can retry transcription + question generation for
        // the same audio range.
        if (isLiveDiaryStepTimeoutError(error)) {
            capabilities.logger.logWarning(
                { sessionId, timeoutMs: error.timeoutMs, step: error.step },
                "Pull cycle: question generation timed out"
            );
        } else {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Pull cycle: question generation failed"
            );
        }
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        return { status: "degraded_question_generation", degradedGap: gapScan.hasDegradedGap };
    }

    const newQuestions = deduplicateQuestions(allQuestions, askedQuestions);

    capabilities.logger.logDebug(
        { sessionId, newQuestionsCount: newQuestions.length },
        "Pull cycle: question generation result"
    );

    // Commit watermark + transcripts + questions in a single atomic batch.
    await commitPullState(temporary, sessionId, {
        ...baseBundle,
        questionCommit: { askedQuestions, newQuestions, cumulativeWordCount, existingPending },
    });

    return { status: "ok", degradedGap: gapScan.hasDegradedGap };
}

module.exports = {
    _runPullCycle,
};
