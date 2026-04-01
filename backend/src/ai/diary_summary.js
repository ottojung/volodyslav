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
 * @property {import('../logger').Logger} logger - A logger instance.
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

const DIARY_SUMMARY_MODEL = "gpt-5.4-mini";

const SYSTEM_PROMPT = `You maintain a structured rolling diary summary.

You receive:
- the CURRENT summary in Markdown
- ONE NEW diary entry, which may include:
  - TYPED TEXT: text typed directly by the user (spelling is reliable)
  - TRANSCRIBED AUDIO: speech-to-text transcription of a recorded audio (may contain transcription errors)
- the summary watermark date
- the new entry date

Note on content reliability:
- Typed text has accurate spelling and punctuation.
- Transcribed audio may contain transcription errors (mishearing, homophones, punctuation gaps).
  Treat uncertain words cautiously; prefer the typed text when both sources are available.

Your task is to update the summary by minimally editing it in place.

Rules:

1. Keep these EXACT 8 headings in this EXACT order:
   ## Ongoing themes and patterns
   ## Important people and relationships
   ## Projects / work / obligations
   ## Decisions / commitments / open loops
   ## Recent important changes
   ## Important long-term facts

2. Output only Markdown, starting with "## Ongoing themes and patterns".
3. Use mostly bullets (- ...). Use short paragraphs only when clearly better.
4. Total target length: 1000-1500 words. Hard cap: 2000 words.
5. Keep each section compact. Prefer updating or merging bullets over adding new ones.
6. If the new entry adds no important information, return the summary unchanged.
7. Preserve uncertainty. Do not invent causes, diagnoses, motives, or hidden explanations.
8. Distinguish observed facts from interpretations. If something is uncertain, say so.
9. Prioritize:
   - deduplication
   - recurring patterns
   - important recent changes
   - important people and relationship dynamics
   - active projects and obligations
   - decisions, intentions, and unresolved open loops
   - notable wins, improvements, and stabilizing factors
   - important long-term facts
10. Aggressively avoid:
   - duplication, rephrasing, and restatements of the same facts
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
18. By "long-term" we mean things that are either impossible or slow to change, such user's name, their personality, or significant footprint from past experience.

Return ONLY the updated markdown.`;

/**
 * @typedef {object} AIDiarySummaryInput
 * @property {string} currentSummaryMarkdown - The current summary markdown.
 * @property {string | undefined} newEntryTypedText - The typed text of the new entry (if present).
 * @property {string | undefined} newEntryTranscribedAudioRecording - The transcribed audio recording of the new entry (if present).
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
        "# NEW ENTRY",
        "",
    ];

    if (input.newEntryTypedText) {
        lines.push("## TYPED TEXT");
        lines.push("");
        lines.push(input.newEntryTypedText);
        lines.push("");
    }

    if (input.newEntryTranscribedAudioRecording) {
        lines.push("## TRANSCRIBED AUDIO");
        lines.push("");
        lines.push(input.newEntryTranscribedAudioRecording);
        lines.push("");
    }

    return lines.join("\n");
}

/**
 * @param {function(string): OpenAI} openai - A memoized function to create an OpenAI client.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {AIDiarySummaryInput} input - The summarizer input.
 * @returns {Promise<AIDiarySummaryOutput>}
 */
async function updateSummary(openai, capabilities, input) {
    capabilities.logger.logDebug({
        newEntryDateISO: input.newEntryDateISO,
        currentSummaryDateISO: input.currentSummaryDateISO,
        hasTypedText: Boolean(input.newEntryTypedText),
        hasTranscribedAudio: Boolean(input.newEntryTranscribedAudioRecording),
    }, "Updating diary summary with new entry");

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
    } finally {
        capabilities.logger.logDebug({
            newEntryDateISO: input.newEntryDateISO,
            currentSummaryDateISO: input.currentSummaryDateISO,
            hasTypedText: Boolean(input.newEntryTypedText),
            hasTranscribedAudio: Boolean(input.newEntryTranscribedAudioRecording),
        }, "Finished attempt to update diary summary");
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
    makeUserMessage,
    make,
    isAIDiarySummaryError,
};
