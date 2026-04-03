/**
 * Lazy pull orchestrator for the cadence-agnostic live diary pipeline.
 *
 * Exports `pullLiveDiaryProcessing` — the public entry point that:
 *   1. Acquires a per-session lock.
 *   2. Delegates to `_runPullCycle` (see pull_cycle.js).
 *   3. Releases the lock in the finally block.
 *
 * No eager per-push transcription.  Pull is triggered by the questioner
 * deadline (GET /live-questions endpoint).
 *
 * @module live_diary/pull_service
 */

const {
    acquirePullLock,
    releasePullLock,
} = require("./session_state");
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

/**
 * @typedef {object} Capabilities
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {AITranscription} aiTranscription
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {AITranscriptRecombination} aiTranscriptRecombination
 * @property {Datetime} datetime
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

/**
 * Execute one pull cycle for a session.
 *
 * All state changes are committed atomically at the end of a successful pull.
 * On any failure the watermark is NOT advanced, ensuring idempotent retry.
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
    const { temporary } = capabilities;
    const nowMs = capabilities.datetime.now().toMillis();

    // 1. Acquire lock.
    const locked = await acquirePullLock(temporary, sessionId, nowMs);
    if (!locked) {
        capabilities.logger.logDebug(
            { sessionId, deadlineMs },
            "Pull cycle skipped: lock already held by another pull"
        );
        return { status: "lock_held" };
    }

    try {
        return await _runPullCycle(capabilities, sessionId, deadlineMs, nowMs, stepTimeoutMs);
    } finally {
        await releasePullLock(temporary, sessionId);
    }
}

module.exports = {
    pullLiveDiaryProcessing,
};
