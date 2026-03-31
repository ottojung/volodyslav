/**
 * @module ai_diary_summary
 *
 * Purpose:
 *   This module provides a unified abstraction for AI-powered diary summarization,
 *   maintaining a structured, rolling summary of diary entries.
 *
 * Conceptual Design Principles:
 *   • Single Responsibility - Focused solely on updating the diary summary from a new transcription.
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

class AIDiarySummaryError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AIDiarySummaryError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AIDiarySummaryError.
 * @param {unknown} object - The error to check.
 * @returns {object is AIDiarySummaryError}
 */
function isAIDiarySummaryError(object) {
    return object instanceof AIDiarySummaryError;
}

const DIARY_SUMMARY_MODEL = "gpt-5.4";

const SYSTEM_PROMPT = `You maintain a structured rolling diary summary.

You receive:
- the CURRENT summary in Markdown
- ONE NEW diary entry transcription
- the summary watermark date
- the new entry date

Your task is to update the summary by minimally editing it in place.

Rules:

1. Keep these EXACT 8 headings in this EXACT order:
   ## Current snapshot
   ## Ongoing themes and patterns
   ## Important people and relationships
   ## Projects / work / obligations
   ## Decisions / commitments / open loops
   ## Recent important changes
   ## Wins / progress / helpful things
   ## Important immutable facts

2. Output only Markdown, starting with "## Current snapshot".
3. Use mostly bullets (- ...). Use short paragraphs only when clearly better.
4. Total target length: 2000-3000 words. Hard cap: 4000 words.
5. Keep each section compact. Prefer updating or merging bullets over adding new ones.
6. If the new entry adds no important information, return the summary unchanged.
7. Preserve uncertainty. Do not invent causes, diagnoses, motives, or hidden explanations.
8. Distinguish observed facts from interpretations. If something is uncertain, say so.
9. Prioritize:
   - recurring patterns
   - important recent changes
   - important people and relationship dynamics
   - active projects and obligations
   - decisions, intentions, and unresolved open loops
   - notable wins, improvements, and stabilizing factors
   - durable background context still needed to interpret future entries
10. Aggressively avoid:
   - decorative detail
   - low-signal one-off facts
   - redundant restatements
   - stale resolved items
   - speculative over-claims
11. Use explicit temporal markers inside bullets whenever relevant, in this format:
   [status: ongoing|recent|resolved] [first: YYYY-MM-DD if known] [last: YYYY-MM-DD]
12. Update temporal markers when merging bullets.
13. If a previously important item is now resolved, mark it resolved and keep it only if it still matters for interpretation.
14. Prefer exact dates from the provided inputs over vague phrases like "recently".
15. Do minimal edits: preserve unchanged bullets verbatim when possible.
16. Keep the summary readable, high-signal, and stable across repeated updates.
17. Output should be in English, except names and special terms, which should stay in their original language.
18. By "immutable" we mean things that are either impossible or very difficult to change, such user's biological traits, name, or significant footprint from past experience.

Return ONLY the updated markdown.`;

/**
 * @typedef {object} AIDiarySummaryInput
 * @property {string} currentSummaryMarkdown - The current summary markdown.
 * @property {string} newEntryTranscriptionText - The transcription text of the new entry.
 * @property {string} currentSummaryDateISO - ISO date of the current summary.
 * @property {string} newEntryDateISO - ISO date of the new entry.
 */

/**
 * @typedef {object} AIDiarySummaryOutput
 * @property {string} summaryMarkdown - The updated summary markdown.
 */

/**
 * @typedef {object} AIDiarySummary
 * @property {(input: AIDiarySummaryInput) => Promise<AIDiarySummaryOutput>} updateSummary
 */

/**
 * @param {AIDiarySummaryInput} input
 * @returns {string}
 */
function makeUserMessage(input) {
    const lines = [
        `Current summary date: ${input.currentSummaryDateISO || "none"}`,
        `New entry date: ${input.newEntryDateISO}`,
        "",
        "# CURRENT SUMMARY",
        "",
        input.currentSummaryMarkdown || "(no summary yet)",
        "",
        "# NEW ENTRY TRANSCRIPTION",
        "",
        input.newEntryTranscriptionText,
    ];
    return lines.join("\n");
}

/**
 * @param {function(string): OpenAI} openai - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {AIDiarySummaryInput} input - The summarizer input.
 * @returns {Promise<AIDiarySummaryOutput>}
 */
async function updateSummary(openai, capabilities, input) {
    try {
        const apiKey = capabilities.environment.openaiAPIKey();
        const response = await openai(apiKey).chat.completions.create({
            model: DIARY_SUMMARY_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: makeUserMessage(input) },
            ],
        });
        const text = response.choices[0]?.message?.content?.trim() ?? "";
        if (!text) {
            throw new AIDiarySummaryError(
                "Model returned an empty response",
                undefined
            );
        }
        return { summaryMarkdown: text };
    } catch (error) {
        if (isAIDiarySummaryError(error)) {
            throw error;
        }
        throw new AIDiarySummaryError(
            `Failed to update diary summary: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }
}

/**
 * Creates an AIDiarySummary capability.
 * @param {() => Capabilities} getCapabilities - A function returning the capabilities object.
 * @returns {AIDiarySummary} - The AI diary summary interface.
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const openai = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        updateSummary: (input) =>
            updateSummary(openai, getCapabilitiesMemo(), input),
    };
}

module.exports = {
    DIARY_SUMMARY_MODEL,
    SYSTEM_PROMPT,
    make,
    isAIDiarySummaryError,
};
