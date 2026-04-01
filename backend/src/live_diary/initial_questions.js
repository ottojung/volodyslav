/**
 * Initial live diary question generation from the diary summary.
 *
 * Called once when a recording session starts (before any audio is pushed).
 * Uses the smart AI model to generate a comprehensive set of personalized questions
 * based on the user's diary summary, then stores them as pending so the client can
 * retrieve them via GET /live-questions.
 *
 * @module live_diary/initial_questions
 */

const { appendPendingQuestions } = require("./session_state");

/** @typedef {import('../temporary').Temporary} Temporary */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('../generators').Interface} Interface */

/**
 * @typedef {object} CapabilitiesWithInterface
 * @property {Temporary} temporary
 * @property {Logger} logger
 * @property {AIDiaryQuestions} aiDiaryQuestions
 * @property {Interface} interface
 */

/**
 * Generate initial diary questions from the diary summary and push them as pending.
 *
 * This is called once at the start of a new recording session (before any audio
 * is pushed).  It fetches the current diary summary, uses the smart AI model
 * to generate a full set of initial questions, and stores them so the client can
 * retrieve them via GET /live-questions.
 *
 * @param {CapabilitiesWithInterface} capabilities
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function generateInitialQuestionsAndPush(capabilities, sessionId) {
    const { temporary } = capabilities;

    let summaryMarkdown;
    try {
        const summary = await capabilities.interface.getDiarySummary();
        summaryMarkdown = summary.markdown;
    } catch (error) {
        capabilities.logger.logWarning(
            { sessionId, error: error instanceof Error ? error.message : String(error) },
            "Live diary failed to fetch diary summary for initial questions; using empty summary"
        );
        summaryMarkdown = "";
    }

    capabilities.logger.logDebug(
        { sessionId, summaryLength: summaryMarkdown.length },
        "Live diary generating initial questions from diary summary"
    );

    let questions;
    try {
        questions = await capabilities.aiDiaryQuestions.generateInitialQuestionsFromSummary(summaryMarkdown);
    } catch (error) {
        capabilities.logger.logError(
            { sessionId, error: error instanceof Error ? error.message : String(error) },
            "Live diary initial question generation failed"
        );
        return;
    }

    if (questions.length === 0) {
        capabilities.logger.logDebug(
            { sessionId },
            "Live diary initial question generation returned no questions"
        );
        return;
    }

    await appendPendingQuestions(temporary, sessionId, questions);

    capabilities.logger.logDebug(
        { sessionId, count: questions.length },
        "Live diary initial questions pushed"
    );
}

module.exports = {
    generateInitialQuestionsAndPush,
};
