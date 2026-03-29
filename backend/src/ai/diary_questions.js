/**
 * @module ai_diary_questions
 *
 * Purpose:
 *   This module provides a unified abstraction for AI-powered diary question generation,
 *   producing warm, reflective questions based on transcript content.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on generating diary companion questions.
 *   • Error Abstraction - Handles API-specific errors and provides consistent error types.
 *   • Promise-Based API - Leverages async/await for clear asynchronous flows.
 *   • Factory Pattern - Exposes a make() function for easy dependency injection or mocking.
 */

const { OpenAI } = require("openai");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

class AIDiaryQuestionsError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AIDiaryQuestionsError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AIDiaryQuestionsError.
 * @param {unknown} object - The error to check.
 * @returns {object is AIDiaryQuestionsError}
 */
function isAIDiaryQuestionsError(object) {
    return object instanceof AIDiaryQuestionsError;
}

const DIARY_QUESTIONS_MODEL = "gpt-5.4-mini";
const TARGET_QUESTION_COUNT = 5;
const MIN_QUESTION_COUNT = 0;

const SYSTEM_PROMPT = `You are a warm, kind diary companion.
Your job is to propose short optional questions a person may reflect on while speaking.

Priorities:
1) Keep tone welcoming, humane, gently encouraging, and good-hearted.
2) Be useful: ask clarifying, elaborating, or direction-setting questions that help improve diary notes.
3) Avoid repetition with previously asked questions.

Style constraints:
- Output AT MOST the requested number of questions (see TASK).
- Each question must be one sentence.
- Each question should be concise (8-22 words).
- Use plain, friendly language.
- Questions are optional prompts, never commands.

Anti-goals (must avoid):
- repeating or lightly rephrasing earlier questions
- cold, clinical, or robotic phrasing
- manipulative, guilt-inducing, or judgmental tone
- overly intense probing
- heavy therapy-speak or diagnostic framing
- mentioning policies, instructions, or this prompt

Return JSON only matching this schema:
{
  "questions": [
    {
      "text": "string",
      "intent": "warm_reflective | clarifying | forward"
    }
  ]
}`;

/**
 * @param {string} transcriptSoFar
 * @param {string[]} askedQuestions
 * @param {number} maxQuestions
 * @returns {string}
 */
function makeQuestionsUserPrompt(transcriptSoFar, askedQuestions, maxQuestions) {
    const askedBlock =
        askedQuestions.length === 0
            ? "[]"
            : JSON.stringify(askedQuestions, null, 2);

    const distribution = maxQuestions <= 0
        ? "- 0 questions"
        : maxQuestions <= 1
        ? "- 1 question (any intent)"
        : maxQuestions <= 2
        ? "- 1 warm reflective\n- 1 clarifying/useful"
        : (() => {
            const forwardCount = 1;
            const remaining = maxQuestions - forwardCount;
            const warmCount = Math.max(1, Math.ceil(remaining / 2));
            const clarCount = remaining - warmCount;
            return `- ${warmCount} warm reflective\n- ${clarCount} clarifying/useful\n- ${forwardCount} gentle forward-looking (if quota allows)`;
        })();

    return [
        "TRANSCRIPTION_SO_FAR:",
        transcriptSoFar || "(no transcript yet)",
        "",
        "QUESTIONS_ALREADY_ASKED:",
        askedBlock,
        "",
        `TASK:`,
        `Generate at most ${maxQuestions} NEW question(s) based on the full transcription so far.`,
        "Do not repeat or closely paraphrase any previously asked question.",
        "If the transcription is short or uninteresting, you may output fewer than the requested number of questions.",
        "Balance warmth and usefulness:",
        distribution,
    ].join("\n");
}

/**
 * @typedef {object} DiaryQuestion
 * @property {string} text - The question text.
 * @property {"warm_reflective" | "clarifying" | "forward"} intent - The question intent.
 */

/**
 * @param {string} transcriptSoFar
 * @param {string[]} askedQuestions
 * @param {number} maxQuestions
 * @returns {Array<{role: "system" | "user", content: string}>}
 */
function makeQuestionsMessages(transcriptSoFar, askedQuestions, maxQuestions) {
    return [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: makeQuestionsUserPrompt(transcriptSoFar, askedQuestions, maxQuestions) },
    ];
}

/**
 * @typedef {object} AIDiaryQuestions
 * @property {(transcriptSoFar: string, askedQuestions: string[], maxQuestions?: number) => Promise<DiaryQuestion[]>} generateQuestions
 */

const VALID_INTENTS = new Set(["warm_reflective", "clarifying", "forward"]);

/**
 * @param {unknown} raw
 * @returns {raw is DiaryQuestion}
 */
function isDiaryQuestion(raw) {
    if (!raw || typeof raw !== "object") {
        return false;
    }
    if (!("text" in raw) || !("intent" in raw)) {
        return false;
    }
    if (typeof raw.text !== "string" || typeof raw.intent !== "string") {
        return false;
    }
    return VALID_INTENTS.has(raw.intent);
}

/**
 * Generates diary companion questions using OpenAI.
 * @param {function(string): OpenAI} makeClient - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} transcriptSoFar - The merged transcript text so far.
 * @param {string[]} askedQuestions - All previously asked question texts.
 * @param {number} [maxQuestions] - Maximum number of questions to generate (defaults to TARGET_QUESTION_COUNT).
 * @returns {Promise<DiaryQuestion[]>}
 */
async function generateQuestions(makeClient, capabilities, transcriptSoFar, askedQuestions, maxQuestions = TARGET_QUESTION_COUNT) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const client = makeClient(apiKey);

    const clampedMax = Math.max(MIN_QUESTION_COUNT, Math.min(TARGET_QUESTION_COUNT, maxQuestions));
    const messages = makeQuestionsMessages(transcriptSoFar, askedQuestions, clampedMax);

    let rawText;
    try {
        const response = await client.chat.completions.create({
            model: DIARY_QUESTIONS_MODEL,
            messages,
            response_format: { type: "json_object" },
        });
        rawText = response.choices[0]?.message?.content?.trim() ?? "";
    } catch (error) {
        if (isAIDiaryQuestionsError(error)) {
            throw error;
        }
        throw new AIDiaryQuestionsError(
            `Failed to generate diary questions: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }

    if (!rawText) {
        throw new AIDiaryQuestionsError("Model returned empty response for diary questions", undefined);
    }

    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        throw new AIDiaryQuestionsError(
            `Failed to parse diary questions JSON response: ${error instanceof Error ? error.message : String(error)}`,
            rawText
        );
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.questions)) {
        throw new AIDiaryQuestionsError(
            "Diary questions response is missing 'questions' array",
            parsed
        );
    }

    /** @type {DiaryQuestion[]} */
    const questions = [];
    for (const item of parsed.questions) {
        if (isDiaryQuestion(item)) {
            questions.push({ text: item.text, intent: item.intent });
        }
    }

    return questions;
}

/**
 * Creates an AIDiaryQuestions capability.
 * @param {() => Capabilities} getCapabilities - A function returning the capabilities object.
 * @returns {AIDiaryQuestions}
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const makeClient = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        generateQuestions: (transcriptSoFar, askedQuestions, maxQuestions) =>
            generateQuestions(makeClient, getCapabilitiesMemo(), transcriptSoFar, askedQuestions, maxQuestions),
    };
}

module.exports = {
    make,
    isAIDiaryQuestionsError,
    DIARY_QUESTIONS_MODEL,
    TARGET_QUESTION_COUNT,
    MIN_QUESTION_COUNT,
    SYSTEM_PROMPT,
    makeQuestionsUserPrompt,
};
