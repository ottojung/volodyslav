/**
 * @module ai_transcript_recombination
 *
 * Purpose:
 *   This module provides LLM-based recombination of partially overlapping transcript
 *   segments, replacing the naive token-replacement approach with an LLM that selects
 *   the best words from both the existing overlap and the new window.
 *
 * Validation:
 *   After the LLM returns a merged transcript, every word in the result is checked
 *   against the union of words in the two input texts.  If any word in the output is
 *   not found in the inputs, the result is rejected and an error is thrown so the
 *   caller can fall back to the new-window text.
 */

const { OpenAI } = require("openai");
const memconst = require("../memconst");
const memoize = require("@emotion/memoize").default;

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

class AITranscriptRecombinationError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AITranscriptRecombinationError";
        this.cause = cause;
    }
}

/**
 * Checks if the error is an AITranscriptRecombinationError.
 * @param {unknown} object
 * @returns {object is AITranscriptRecombinationError}
 */
function isAITranscriptRecombinationError(object) {
    return object instanceof AITranscriptRecombinationError;
}

const RECOMBINATION_MODEL = "gpt-5.2";

const SYSTEM_PROMPT = `You are a transcript editor.

You receive two overlapping transcript segments from the same audio recording.
The EXISTING segment is from an earlier transcription pass covering the overlap region.
The NEW segment is from a more recent transcription pass covering the overlap region and any new audio.

Your task: produce a single clean, continuous transcript.

Rules:
- Use ONLY words that appear in the EXISTING or NEW segment — do not add, invent, or infer any new words.
- Prefer the wording from the NEW segment when both segments say something similar.
- Remove duplicate or repeated phrases caused by the overlap.
- Preserve the natural flow and meaning of the combined text.
- Output only the final transcript text with no labels, headers, or commentary.`;

/**
 * Build the user prompt for transcript recombination.
 * @param {string} existingOverlapText - Existing transcript text covering the overlap zone.
 * @param {string} newWindowText - New window transcript text.
 * @returns {string}
 */
function makeUserPrompt(existingOverlapText, newWindowText) {
    return [
        "EXISTING segment (overlap region from prior transcription):",
        existingOverlapText || "(empty)",
        "",
        "NEW segment (latest transcription, covers overlap and new audio):",
        newWindowText || "(empty)",
        "",
        "Produce the merged transcript using only words from the inputs above.",
    ].join("\n");
}

/**
 * Normalise text into a set of lowercase words for validation.
 * Strips surrounding punctuation but preserves internal apostrophes and hyphens
 * so that contractions ("it's" → "it's") and hyphenated words ("twenty-one" →
 * "twenty-one") are compared consistently between input and output.
 * @param {string} text
 * @returns {Set<string>}
 */
function makeWordSet(text) {
    return new Set(
        text
            .toLowerCase()
            .split(/\s+/)
            .map((w) =>
                w
                    .replace(/[^a-z0-9'-]/g, "")
                    .replace(/^[-']+|[-']+$/g, "")
            )
            .filter(Boolean)
    );
}

/**
 * Validate that every word in `output` appears in `allowedWords`.
 * @param {string} output
 * @param {Set<string>} allowedWords
 * @returns {boolean}
 */
function validateWordSubset(output, allowedWords) {
    const outputWords = makeWordSet(output);
    for (const word of outputWords) {
        if (!allowedWords.has(word)) {
            return false;
        }
    }
    return true;
}

/**
 * Recombine two overlapping transcript segments using an LLM.
 * @param {function(string): OpenAI} makeClient - Memoized factory for OpenAI client.
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText - Existing transcript text in the overlap zone.
 * @param {string} newWindowText - New window transcript text.
 * @returns {Promise<string>} The recombined transcript text.
 */
async function recombineOverlap(makeClient, capabilities, existingOverlapText, newWindowText) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const client = makeClient(apiKey);

    /** @type {Array<{role: "system" | "user", content: string}>} */
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: makeUserPrompt(existingOverlapText, newWindowText) },
    ];

    let rawText;
    try {
        const response = await client.chat.completions.create({
            model: RECOMBINATION_MODEL,
            messages,
        });
        rawText = response.choices[0]?.message?.content?.trim() ?? "";
    } catch (error) {
        throw new AITranscriptRecombinationError(
            `Failed to recombine transcripts: ${error instanceof Error ? error.message : String(error)}`,
            error
        );
    }

    if (!rawText) {
        throw new AITranscriptRecombinationError(
            "Model returned empty response for transcript recombination",
            undefined
        );
    }

    // Validate: every word in the result must appear in the original inputs.
    const allowedWords = makeWordSet(`${existingOverlapText} ${newWindowText}`);
    if (!validateWordSubset(rawText, allowedWords)) {
        throw new AITranscriptRecombinationError(
            "Recombined transcript contains words not found in original inputs",
            { existingOverlapText, newWindowText, rawText }
        );
    }

    return rawText;
}

/**
 * @typedef {object} AITranscriptRecombination
 * @property {(existingOverlapText: string, newWindowText: string) => Promise<string>} recombineOverlap
 */

/**
 * Creates an AITranscriptRecombination capability.
 * @param {() => Capabilities} getCapabilities - A function returning the capabilities object.
 * @returns {AITranscriptRecombination}
 */
function make(getCapabilities) {
    const getCapabilitiesMemo = memconst(getCapabilities);
    const makeClient = memoize((apiKey) => new OpenAI({ apiKey }));
    return {
        recombineOverlap: (existingOverlapText, newWindowText) =>
            recombineOverlap(makeClient, getCapabilitiesMemo(), existingOverlapText, newWindowText),
    };
}

module.exports = {
    make,
    isAITranscriptRecombinationError,
    RECOMBINATION_MODEL,
    SYSTEM_PROMPT,
    makeUserPrompt,
    makeWordSet,
    validateWordSubset,
};
