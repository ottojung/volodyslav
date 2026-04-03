/**
 * Internal pull cycle implementation for the cadence-agnostic live diary pipeline.
 *
 * Contains the core `_runPullCycle` function (runs with the per-session lock held).
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
    writeStringField,
    readAskedQuestions,
    readPendingQuestions,
    commitQuestionGenerationResult,
    listFragmentIndex,
    readTranscribedUntilMs,
    writeTranscribedUntilMs,
    readLastTranscribedRange,
    writeLastTranscribedRange,
    readKnownGaps,
    writeKnownGaps,
} = require("./session_state");
const { buildWav } = require("./wav_utils");
const { planWindow } = require("./planner");
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

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 */

/**
 * @typedef {'ok' | 'no_candidates' | 'blocked_at_watermark' | 'lock_held'
 *   | 'degraded_transcription' | 'degraded_question_generation'} PullStatus
 */

/**
 * @typedef {object} PullResult
 * @property {PullStatus} status
 * @property {boolean} [degradedGap] - True when at least one abandoned gap was crossed.
 */

// ---------------------------------------------------------------------------
// Main pull cycle (runs with lock held)
// ---------------------------------------------------------------------------

/**
 * Internal pull cycle implementation (runs with lock held).
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
    const candidates = allFragments.filter(
        (f) => f.endMs > transcribedUntilMs && f.startMs < deadlineMs
    );

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

    const { windowStartMs, windowEndMs, effectiveOverlapMs } = planWindow({
        transcribedUntilMs,
        processableEndMs,
        prevNewDurationMs,
    });

    capabilities.logger.logDebug(
        {
            sessionId,
            transcribedUntilMs,
            processableEndMs,
            windowStartMs,
            windowEndMs,
            effectiveOverlapMs,
            hasDegradedGap: gapScan.hasDegradedGap,
        },
        "Pull cycle: window planned"
    );

    // 6. Assemble PCM for [windowStartMs, windowEndMs].
    const firstCandidate = candidates[0];
    if (firstCandidate === undefined) {
        // Unreachable: candidates.length > 0 was checked above.
        return { status: "no_candidates" };
    }
    const { sampleRateHz, channels, bitDepth } = firstCandidate;

    /** @type {import('./assembler').AssemblerFragment[]} */
    const assemblerFragments = [];
    for (const frag of allFragments) {
        if (frag.endMs <= windowStartMs || frag.startMs >= windowEndMs) continue;
        const pcm = await loadFragmentPcm(temporary, sessionId, frag.sequence);
        if (pcm === null) {
            capabilities.logger.logWarning(
                { sessionId, sequence: frag.sequence },
                "Pull cycle: binary PCM missing for fragment — treating as silence"
            );
            continue;
        }
        assemblerFragments.push({ ...frag, pcm });
    }

    let combinedPcm;
    try {
        combinedPcm = assemblePcm({
            fragments: assemblerFragments,
            windowStartMs,
            windowEndMs,
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
        return { status: "degraded_transcription" };
    }

    const windowWav = buildWav(combinedPcm, sampleRateHz, channels, bitDepth);

    // 7. Transcribe.
    let newWindowTranscript;
    try {
        newWindowTranscript = await withStepTimeout(
            "transcription",
            () => transcribeBuffer(windowWav, "audio/wav", capabilities),
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
        return { status: "degraded_transcription" };
    }

    capabilities.logger.logDebug(
        { sessionId, transcriptLength: newWindowTranscript.length, windowStartMs, windowEndMs },
        "Pull cycle: transcription result"
    );

    if (!newWindowTranscript) {
        await writeTranscribedUntilMs(temporary, sessionId, processableEndMs);
        await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
        await _updateLastRange(temporary, sessionId, candidates, transcribedUntilMs, processableEndMs);
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
        } catch (error) {
            capabilities.logger.logError(
                { sessionId, error: error instanceof Error ? error.message : String(error) },
                "Pull cycle: recombination failed — using new window transcript directly"
            );
            merged = newWindowTranscript;
        }
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

    capabilities.logger.logDebug(
        {
            sessionId,
            runningTranscriptLength: updatedRunningTranscript.length,
            suffix: updatedRunningTranscript.slice(-532),
        },
        "Pull cycle: running transcript updated (532-char suffix shown)"
    );

    // 10. Word count and question generation.
    const newTranscriptPortion =
        runningTranscript && updatedRunningTranscript.startsWith(runningTranscript)
            ? updatedRunningTranscript.slice(runningTranscript.length)
            : merged;
    const fragmentWordCount = newTranscriptPortion.split(/\s+/).filter(Boolean).length;
    const storedWordCount = await readStringField(temporary, sessionId, WORDS_SINCE_LAST_QUESTION_KEY);
    const cumulativeWordCount = (parseInt(storedWordCount, 10) || 0) + fragmentWordCount;

    await writeStringField(temporary, sessionId, LAST_WINDOW_TRANSCRIPT_KEY, newWindowTranscript);
    await writeStringField(temporary, sessionId, RUNNING_TRANSCRIPT_KEY, updatedRunningTranscript);
    await writeTranscribedUntilMs(temporary, sessionId, processableEndMs);
    await writeKnownGaps(temporary, sessionId, gapScan.updatedGaps);
    await _updateLastRange(temporary, sessionId, candidates, transcribedUntilMs, processableEndMs);

    if (cumulativeWordCount < 10) {
        await writeStringField(temporary, sessionId, WORDS_SINCE_LAST_QUESTION_KEY, String(cumulativeWordCount));
        capabilities.logger.logDebug(
            { sessionId, cumulativeWordCount },
            "Pull cycle: word count below threshold; skipping question generation"
        );
        return { status: "ok", degradedGap: gapScan.hasDegradedGap };
    }

    const existingPending = await readPendingQuestions(temporary, sessionId);
    if (existingPending.length > 0) {
        await writeStringField(temporary, sessionId, WORDS_SINCE_LAST_QUESTION_KEY, String(cumulativeWordCount));
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
            () => capabilities.aiDiaryQuestions.generateQuestions(
                updatedRunningTranscript,
                askedQuestions,
                maxQuestions
            ),
            stepTimeoutMs
        );
    } catch (error) {
        await writeStringField(temporary, sessionId, WORDS_SINCE_LAST_QUESTION_KEY, String(cumulativeWordCount));
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
        return { status: "degraded_question_generation", degradedGap: gapScan.hasDegradedGap };
    }

    const newQuestions = deduplicateQuestions(allQuestions, askedQuestions);

    capabilities.logger.logDebug(
        { sessionId, newQuestionsCount: newQuestions.length },
        "Pull cycle: question generation result"
    );

    await commitQuestionGenerationResult(
        temporary,
        sessionId,
        askedQuestions,
        newQuestions,
        cumulativeWordCount
    );

    return { status: "ok", degradedGap: gapScan.hasDegradedGap };
}

/**
 * Persist the last-transcribed-range metadata from the current pull's new fragments.
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {import('../temporary/database/types').LiveDiaryFragmentIndexEntry[]} candidates
 * @param {number} transcribedUntilMs
 * @param {number} processableEndMs
 * @returns {Promise<void>}
 */
async function _updateLastRange(temporary, sessionId, candidates, transcribedUntilMs, processableEndMs) {
    const newFragments = candidates.filter(
        (f) => f.startMs < processableEndMs && f.endMs > transcribedUntilMs
    );
    if (newFragments.length === 0) return;
    const firstNewFrag = newFragments[0];
    const lastNewFrag = newFragments[newFragments.length - 1];
    if (firstNewFrag === undefined || lastNewFrag === undefined) return;
    await writeLastTranscribedRange(temporary, sessionId, {
        firstStartMs: firstNewFrag.startMs,
        lastEndMs: Math.min(lastNewFrag.endMs, processableEndMs),
        fragmentCount: newFragments.length,
    });
}

module.exports = {
    _runPullCycle,
};
