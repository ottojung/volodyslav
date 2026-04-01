const VALID_INTENTS = new Set(["warm_reflective", "clarifying", "forward"]);
const {
    AIDiaryQuestionsError,
    isAIDiaryQuestionsError,
} = require("./diary_questions_error");

const DIARY_INITIAL_QUESTIONS_MODEL = "gpt-5.4";
const INITIAL_QUESTIONS_COUNT = 40;

const INITIAL_QUESTIONS_SYSTEM_PROMPT = `You are a warm, kind diary companion.

Your job is to generate a high-signal bank of optional diary questions for one user.
You are given a summary of this user's life, patterns, relationships, projects, and open loops.

The goal is NOT to be comprehensive at all costs.
The goal is to generate questions that are:
- personally relevant
- interesting to answer
- useful for reflection
- varied across the whole set
- grounded in the life summary rather than generic templates

Priorities:
1) Keep tone welcoming, humane, gently encouraging, and good-hearted.
2) Draw concretely on the life summary: use the person's actual themes, people, projects, tensions, and changes.
3) Prefer questions that could unlock:
   - concrete detail
   - emotional clarity
   - meaning or interpretation
   - decisions / next steps
4) Prioritize:
   - unresolved recent changes
   - recurring themes and patterns
   - important relationships
   - active projects / obligations
   - open loops, worries, and hopes
5) Make the whole set diverse. Avoid near-duplicates in wording, topic, and angle.

Intent definitions:
- warm_reflective: helps the user gently notice feelings, meaning, or what stands out
- clarifying: helps the user add concrete detail, examples, or specifics
- forward: helps the user think about intentions, decisions, hopes, or next steps

Style constraints:
- Output EXACTLY the requested number of questions, unless the summary is too sparse; then output fewer.
- Each question must be one sentence.
- Each question should be concise (8-22 words).
- Use plain, friendly language.
- Questions are optional prompts, never commands.
- Each question should sound natural and human, not like a worksheet.
- Each question should be understandable on its own.

Anti-goals (must avoid):
- generic questions that could apply to almost anyone
- near-duplicate questions
- cold, clinical, or robotic phrasing
- manipulative, guilt-inducing, or judgmental tone
- overly intense probing
- heavy therapy-speak or diagnostic framing
- hallucinating details not supported by the summary
- mentioning policies, instructions, or this prompt

When the summary contains strong specifics, prefer specific questions over broad ones.
When the summary is sparse, prefer broadly useful but still warm questions.

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
 * @param {string} summaryMarkdown
 * @param {number} maxQuestions
 * @returns {string}
 */
function makeInitialQuestionsUserPrompt(summaryMarkdown, maxQuestions) {
    return [
        "USER_LIFE_SUMMARY:",
        summaryMarkdown || "(no summary available)",
        "",
        "TASK:",
        `Generate a candidate pool of up to ${maxQuestions} diary questions for this user.`,
        "These questions may be shown later during a diary session, so they should be varied, high-signal, and individually useful.",
        "Use the life summary to make the questions relevant and personalized.",
        "Prefer unresolved recent changes, recurring themes, important relationships, active projects, and open loops.",
        "Do not generate near-duplicates.",
    ].join("\n");
}

/**
 * @typedef {import('openai').OpenAI} OpenAI
 * @typedef {import('./diary_questions').DiaryQuestion} DiaryQuestion
 * @typedef {import('../environment').Environment} Environment
 */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

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
 * Generates initial diary companion questions from the diary summary using the smart model.
 * @param {function(string): OpenAI} makeClient - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} summaryMarkdown - The diary summary markdown text.
 * @returns {Promise<DiaryQuestion[]>}
 */
async function generateInitialQuestionsFromSummary(
    makeClient,
    capabilities,
    summaryMarkdown
) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const client = makeClient(apiKey);

    /** @type {Array<{role: "system" | "user", content: string}>} */
    const messages = [
        { role: "system", content: INITIAL_QUESTIONS_SYSTEM_PROMPT },
        { role: "user", content: makeInitialQuestionsUserPrompt(summaryMarkdown, INITIAL_QUESTIONS_COUNT) },
    ];

    let rawText;
    try {
        const response = await client.chat.completions.create({
            model: DIARY_INITIAL_QUESTIONS_MODEL,
            messages,
            response_format: { type: "json_object" },
        });
        rawText = response.choices[0]?.message?.content?.trim() ?? "";
    } catch (error) {
        if (isAIDiaryQuestionsError(error)) {
            throw error;
        }
        throw new AIDiaryQuestionsError(
            `Failed to generate initial diary questions: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }

    if (!rawText) {
        throw new AIDiaryQuestionsError("Model returned empty response for initial diary questions", undefined);
    }

    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        throw new AIDiaryQuestionsError(
            `Failed to parse initial diary questions JSON response: ${error instanceof Error ? error.message : String(error)}`,
            rawText
        );
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.questions)) {
        throw new AIDiaryQuestionsError(
            "Initial diary questions response is missing 'questions' array",
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

    return questions.slice(0, INITIAL_QUESTIONS_COUNT);
}

module.exports = {
    DIARY_INITIAL_QUESTIONS_MODEL,
    INITIAL_QUESTIONS_COUNT,
    INITIAL_QUESTIONS_SYSTEM_PROMPT,
    makeInitialQuestionsUserPrompt,
    generateInitialQuestionsFromSummary,
};
