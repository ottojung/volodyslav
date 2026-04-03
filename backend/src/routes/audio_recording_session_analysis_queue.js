/**
 * Per-session serializing queue for live-diary analysis audio processing.
 *
 * Extracted from audio_recording_session.js to keep that file under the
 * 300-code-line ESLint limit.
 *
 * @module routes/audio_recording_session_analysis_queue
 */

const {
    generateInitialQuestionsAndPush,
    getPendingQuestions: getLiveDiaryPendingQuestions,
    pullLiveDiaryProcessing,
} = require("../live_diary");

/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */
/** @typedef {import('../generators').Interface} Interface */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} Capabilities
 * @property {Logger} logger
 * @property {Temporary} temporary
 * @property {Datetime} datetime
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 * @property {Interface} interface
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {FileDeleter} deleter
 */

/**
 * Per-session promise chain for serializing live-diary AI processing.
 * Storing the tail promise per session ensures that fragments are processed
 * in order without blocking the HTTP response.
 *
 * @type {Map<string, Promise<void>>}
 */
const processingQueues = new Map();

/**
 * Remove the queue entry for a session (called when the session is discarded).
 * Any in-flight AI processing continues to completion, but subsequent fragments
 * for this session will start a fresh queue chain.
 *
 * @param {string} sessionId
 */
function dequeueSession(sessionId) {
    processingQueues.delete(sessionId);
}

/**
 * Enqueue initial live diary question generation for a new recording session.
 *
 * Chains `generateInitialQuestionsAndPush` onto the same per-session promise
 * queue as pull cycles, so it cannot interleave with concurrent
 * pull cycles that also write to the pending-questions store.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {void}
 */
function enqueueInitialQuestions(capabilities, sessionId) {
    const existing = (processingQueues.get(sessionId) ?? Promise.resolve()).catch(() => Promise.resolve());
    const next = existing.then(async () => {
        try {
            await generateInitialQuestionsAndPush(capabilities, sessionId);
            capabilities.logger.logDebug(
                { sessionId },
                "Live diary initial question generation completed"
            );
        } catch (error) {
            capabilities.logger.logError(
                {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
                "Live diary initial question generation failed"
            );
        }
    });
    processingQueues.set(sessionId, next);
    next.finally(() => {
        if (processingQueues.get(sessionId) === next) {
            processingQueues.delete(sessionId);
        }
    }).catch(() => {
        capabilities.logger.logError(
            { sessionId },
            "Unexpected error in live diary initial question generation queue"
        );
    });
}

/**
 * Enqueue a pull cycle for a session.
 *
 * Chains `pullLiveDiaryProcessing` onto the per-session promise queue.
 * Non-blocking: callers do not wait for the pull to complete.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {number} deadlineMs
 * @returns {void}
 */
function enqueuePull(capabilities, sessionId, deadlineMs) {
    const existing = (processingQueues.get(sessionId) ?? Promise.resolve()).catch(() => Promise.resolve());
    const next = existing.then(async () => {
        try {
            const result = await pullLiveDiaryProcessing(capabilities, sessionId, deadlineMs);
            capabilities.logger.logDebug(
                { sessionId, deadlineMs, status: result.status, degradedGap: result.degradedGap },
                "Live diary pull cycle completed"
            );
        } catch (error) {
            capabilities.logger.logError(
                {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
                "Live diary pull cycle failed"
            );
        }
    });
    processingQueues.set(sessionId, next);
    next.finally(() => {
        if (processingQueues.get(sessionId) === next) {
            processingQueues.delete(sessionId);
        }
    }).catch(() => {
        capabilities.logger.logError(
            { sessionId },
            "Unexpected error in live diary pull cycle queue"
        );
    });
}

/**
 * Enqueue fetching+clearing pending live diary questions.
 *
 * Triggers a pull cycle before reading questions so that the caller receives
 * up-to-date questions generated from all fragments up to the current deadline.
 * The pull runs in the same per-session queue to avoid races with other writers.
 *
 * Uses Number.MAX_SAFE_INTEGER as deadlineMs so that all uploaded fragments
 * (regardless of their startMs/endMs timestamps) are eligible for the pull.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @returns {Promise<Array<{text: string, intent: string}>>}
 */
function enqueuePendingQuestionsFetch(capabilities, sessionId) {
    // Use MAX_SAFE_INTEGER so the pull considers all uploaded fragments,
    // regardless of whether their timestamps match wall-clock time.
    const deadlineMs = Number.MAX_SAFE_INTEGER;
    const existing = (processingQueues.get(sessionId) ?? Promise.resolve()).catch(() => Promise.resolve());
    const readPromise = existing
        .then(async () => {
            // Run a pull cycle inline so questions are generated before we read them.
            try {
                await pullLiveDiaryProcessing(capabilities, sessionId, deadlineMs);
            } catch (error) {
                capabilities.logger.logError(
                    {
                        sessionId,
                        error: error instanceof Error ? error.message : String(error),
                    },
                    "Live diary pull cycle failed during question fetch"
                );
            }
        })
        .then(() => getLiveDiaryPendingQuestions(capabilities, sessionId));
    const next = readPromise.then(
        () => undefined,
        () => undefined
    );
    processingQueues.set(sessionId, next);
    next.finally(() => {
        if (processingQueues.get(sessionId) === next) {
            processingQueues.delete(sessionId);
        }
    });
    return readPromise;
}

module.exports = {
    enqueueInitialQuestions,
    enqueuePull,
    enqueuePendingQuestionsFetch,
    dequeueSession,
};

