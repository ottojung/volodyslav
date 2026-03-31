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

const SYSTEM_PROMPT = `You maintain a structured diary summary. You receive the CURRENT summary and ONE NEW diary entry transcription. Update the summary by incorporating the new entry.

Rules:
1. Keep these EXACT 8 headings in this EXACT order:
   ## Current snapshot
   ## Ongoing themes and patterns
   ## Important people and relationships
   ## Projects / work / obligations
   ## Health / symptoms / body / habits
   ## Decisions / commitments / open loops
   ## Recent important changes
   ## Wins / progress / helpful things

2. Format: Mostly bullets (- ...). Short paragraphs only when clearly better.
3. Where useful, add first-seen/last-seen/recency markers inside bullets.
4. Perform in-place merge updates — update existing bullets rather than just appending.
5. Preserve uncertainty; avoid speculative over-claims.
6. Never add, remove, or rename headings. Keep heading text exactly as given.
7. Keep the summary focused and concise — prioritize recent and significant information.
8. Output should be in English, except for names and special terms, which should be in their original language.

Return ONLY the updated markdown, starting with "## Current snapshot".`;

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
        "## CURRENT SUMMARY",
        "",
        input.currentSummaryMarkdown || "(no summary yet)",
        "",
        "## NEW ENTRY TRANSCRIPTION",
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
