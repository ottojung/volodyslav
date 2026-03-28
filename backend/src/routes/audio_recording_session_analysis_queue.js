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
 * Per-session promise chain for serializing live-diary AI processing.
 * Storing the tail promise per session ensures that fragments are processed
 * in order without blocking the HTTP response.
 *
 * @type {Map<string, Promise<void>>}
 */
const processingQueues = new Map();

/**
 * Enqueue a live-diary analysis audio fragment for async AI processing.
 * The fragment is processed after all previously enqueued fragments for the
 * same session, without blocking the HTTP response.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {Buffer} analysisBuffer - WAV-wrapped PCM audio fragment.
 * @param {number} sequenceNum - Fragment sequence number (0-based).
 */
function enqueueAnalysis(capabilities, sessionId, analysisBuffer, sequenceNum) {
    const existing = (processingQueues.get(sessionId) ?? Promise.resolve()).catch(() => Promise.resolve());
    const next = existing.then(async () => {
        try {
            await pushLiveDiaryAudio(
                capabilities,
                sessionId,
                analysisBuffer,
                "audio/wav",
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
