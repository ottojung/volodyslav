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
const initialQuestions = require("./diary_initial_questions");
const {
    AIDiaryQuestionsError,
    isAIDiaryQuestionsError,
    AIDiaryQuestionsCallTimeoutError,
    isAIDiaryQuestionsCallTimeoutError,
} = require("./diary_questions_error");

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

const DIARY_QUESTIONS_MODEL = "gpt-5.4-mini";
const TARGET_QUESTION_COUNT = 5;
const MIN_QUESTION_COUNT = 0;

/**
 * LLM output rate for chat completions (words per second).
 * Used to estimate generation time from output size.
 */
const LLM_OUTPUT_RATE_WPS = 75;

/**
 * Maximum words per question as constrained by the system prompt.
 * The system prompt instructs: "Each question should be concise (8-22 words)".
 */
const MAX_WORDS_PER_QUESTION = 22;

/**
 * Approximate HTTP body upload rate for LLM API calls (characters per ms).
 * At ~100 KB/s, which is conservative for typical network conditions.
 */
const LLM_HTTP_BODY_CHARS_PER_MS = 100;

/**
 * Fixed overhead per API call (ms): queue wait, cold start, network round-trip.
 * Generous to avoid false positives under API load.
 */
const LLM_CALL_OVERHEAD_MS = 30_000;

/**
 * Compute a per-call timeout for question generation based on actual inputs.
 *
 * Two components:
 *   - HTTP body transfer: proportional to transcript character count (dominant for long sessions)
 *   - Output generation: bounded by maxQuestions × MAX_WORDS_PER_QUESTION words at LLM_OUTPUT_RATE_WPS
 *   - Fixed overhead for queue wait, model initialization, and network round-trip
 *
 * @param {string} transcriptSoFar - The transcript text sent in the request body.
 * @param {number} maxQuestions - Maximum number of questions requested.
 * @returns {number} Timeout in milliseconds.
 */
function computeQuestionsTimeoutMs(transcriptSoFar, maxQuestions) {
    const transferMs = Math.ceil(transcriptSoFar.length / LLM_HTTP_BODY_CHARS_PER_MS);
    const outputMs = Math.ceil(maxQuestions * MAX_WORDS_PER_QUESTION / LLM_OUTPUT_RATE_WPS) * 1_000;
    return transferMs + outputMs + LLM_CALL_OVERHEAD_MS;
}

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
 * @property {(summaryMarkdown: string) => Promise<DiaryQuestion[]>} generateInitialQuestionsFromSummary
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
 *
 * Each call is bounded by a per-call timeout computed from the actual inputs
 * via computeQuestionsTimeoutMs.  If the API does not respond within that
 * window an AIDiaryQuestionsCallTimeoutError is thrown.
 *
 * @param {function(string): OpenAI} makeClient - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} transcriptSoFar - The merged transcript text so far.
 * @param {string[]} askedQuestions - All previously asked question texts.
 * @param {number} [maxQuestions] - Maximum number of questions to generate (defaults to TARGET_QUESTION_COUNT).
 * @returns {Promise<DiaryQuestion[]>}
 */
async function generateQuestions(makeClient, capabilities, transcriptSoFar, askedQuestions, maxQuestions = TARGET_QUESTION_COUNT) {
    const clampedMax = Math.max(MIN_QUESTION_COUNT, Math.min(TARGET_QUESTION_COUNT, maxQuestions));
    if (clampedMax === 0) {
        return [];
    }

    const timeoutMs = computeQuestionsTimeoutMs(transcriptSoFar, clampedMax);
    const controller = new AbortController();
    const messages = makeQuestionsMessages(transcriptSoFar, askedQuestions, clampedMax);

    let rawText;
    let timerId;
    try {
        timerId = setTimeout(() => controller.abort(), timeoutMs);
        const apiKey = capabilities.environment.openaiAPIKey();
        const client = makeClient(apiKey);
        const response = await client.chat.completions.create({
            model: DIARY_QUESTIONS_MODEL,
            messages,
            response_format: { type: "json_object" },
        }, { signal: controller.signal });
        rawText = response.choices[0]?.message?.content?.trim() ?? "";
    } catch (error) {
        if (controller.signal.aborted) {
            throw new AIDiaryQuestionsCallTimeoutError(transcriptSoFar.length, clampedMax, timeoutMs);
        }
        if (isAIDiaryQuestionsError(error)) {
            throw error;
        }
        throw new AIDiaryQuestionsError(
            `Failed to generate diary questions: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    } finally {
        if (timerId !== undefined) {
            clearTimeout(timerId);
        }
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

    return questions.slice(0, clampedMax);
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
        generateInitialQuestionsFromSummary: (summaryMarkdown) =>
            initialQuestions.generateInitialQuestionsFromSummary(
                makeClient,
                getCapabilitiesMemo(),
                summaryMarkdown
            ),
    };
}

module.exports = {
    make,
    isAIDiaryQuestionsError,
    isAIDiaryQuestionsCallTimeoutError,
    computeQuestionsTimeoutMs,
    DIARY_QUESTIONS_MODEL,
    TARGET_QUESTION_COUNT,
    MIN_QUESTION_COUNT,
    SYSTEM_PROMPT,
    makeQuestionsUserPrompt,
    DIARY_INITIAL_QUESTIONS_MODEL: initialQuestions.DIARY_INITIAL_QUESTIONS_MODEL,
    INITIAL_QUESTIONS_COUNT: initialQuestions.INITIAL_QUESTIONS_COUNT,
    INITIAL_QUESTIONS_SYSTEM_PROMPT: initialQuestions.INITIAL_QUESTIONS_SYSTEM_PROMPT,
    makeInitialQuestionsUserPrompt: initialQuestions.makeInitialQuestionsUserPrompt,
};
