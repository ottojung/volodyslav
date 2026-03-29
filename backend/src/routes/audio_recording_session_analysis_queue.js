/**
 * Per-session serializing queue for live-diary analysis audio processing.
 *
 * Extracted from audio_recording_session.js to keep that file under the
 * 300-code-line ESLint limit.
 *
 * @module routes/audio_recording_session_analysis_queue
 */

const { pushAudio: pushLiveDiaryAudio } = require("../live_diary");

/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */

/**
 * @typedef {object} Capabilities
 * @property {Logger} logger
 * @property {Temporary} temporary
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 */

/**
 * @typedef {import('../live_diary/service').PcmInfo} PcmInfo
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
 * Enqueue a live-diary PCM audio fragment for async AI processing.
 * The fragment is processed after all previously enqueued fragments for the
 * same session, without blocking the HTTP response.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {PcmInfo} pcmInfo - Raw PCM audio fragment with format metadata.
 * @param {number} sequenceNum - Fragment sequence number (0-based).
 */
function enqueueAnalysis(capabilities, sessionId, pcmInfo, sequenceNum) {
    const existing = (processingQueues.get(sessionId) ?? Promise.resolve()).catch(() => Promise.resolve());
    const next = existing.then(async () => {
        try {
            await pushLiveDiaryAudio(
                capabilities,
                sessionId,
                pcmInfo,
                sequenceNum + 1
            );
            capabilities.logger.logDebug(
                { sessionId, sequence: sequenceNum },
                "Live diary AI processing completed for fragment"
            );
        } catch (error) {
            capabilities.logger.logError(
                {
                    sessionId,
                    sequence: sequenceNum,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                },
                "Live diary AI processing failed for fragment"
            );
        }
    });
    processingQueues.set(sessionId, next);
    next.finally(() => {
        // Delete only if this promise is still the latest tail for the session.
        // This avoids removing a newer queue tail enqueued after this one.
        if (processingQueues.get(sessionId) === next) {
            processingQueues.delete(sessionId);
        }
    }).catch(() => {
        // This `next` should never reject because the then-callback above catches all
        // errors internally, but if the logger itself throws the rejection must
        // not become an unhandled promise rejection that could crash the process.
        capabilities.logger.logError(
            { sessionId, sequence: sequenceNum },
            "Unexpected error in live diary AI processing queue"
        );
    });
}

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

module.exports = { enqueueAnalysis, dequeueSession };
