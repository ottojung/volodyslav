/**
 * Lazy pull orchestrator for the cadence-agnostic live diary pipeline.
 *
 * Exports `pullLiveDiaryProcessing` — the public entry point that delegates
 * to `_runPullCycle` (see pull_cycle.js).
 *
 * Mutual exclusion is guaranteed by the caller: `pullLiveDiaryProcessing`
 * is always invoked through the per-session `processingQueues` promise chain
 * in `audio_recording_session_analysis_queue.js`, so concurrent pulls for the
 * same session cannot interleave within a single Node.js process.
 *
 * No eager per-push transcription.  Pull is triggered by the questioner
 * deadline (GET /live-questions endpoint).
 *
 * @module live_diary/pull_service
 */

const {
    DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS,
} = require("./step_timeout");
const { _runPullCycle } = require("./pull_cycle");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../ai/transcript_recombination').AITranscriptRecombination} AITranscriptRecombination */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 * @property {Datetime} datetime
 * @property {FileCreator} creator
 * @property {FileWriter} writer
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

/**
 * Execute one pull cycle for a session.
 *
 * All state changes are committed atomically at the end of a successful pull.
 * On any failure the watermark is NOT advanced, ensuring idempotent retry.
 *
 * Mutual exclusion: callers must ensure only one pull runs per session at a
 * time.  The `enqueuePendingQuestionsFetch` in
 * `audio_recording_session_analysis_queue.js` provides this guarantee via the
 * per-session `processingQueues` promise chain.
 *
 * @param {Capabilities} capabilities
 * @param {string} sessionId
 * @param {number} deadlineMs - Upper bound of the data range to process.
 *   Use `Number.MAX_SAFE_INTEGER` to process all uploaded fragments.
 * @param {number} [stepTimeoutMs]
 * @returns {Promise<PullResult>}
 */
async function pullLiveDiaryProcessing(
    capabilities,
    sessionId,
    deadlineMs,
    stepTimeoutMs = DEFAULT_LIVE_DIARY_STEP_TIMEOUT_MS
) {
    const nowMs = capabilities.datetime.now().toMillis();
    return _runPullCycle(capabilities, sessionId, deadlineMs, nowMs, stepTimeoutMs);
}

module.exports = {
    pullLiveDiaryProcessing,
};
