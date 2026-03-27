/**
 * @module ai_transcript_recombination
 *
 * Purpose:
 *   This module provides LLM-based recombination of partially overlapping transcript
 *   segments, replacing the naive token-replacement approach with an LLM that selects
 *   the best words from both the existing overlap and the new window.
 *
 * Fragment approach:
 *   The new window text is split into fragments of at most FRAGMENT_MAX_WORDS words
 *   (~20 seconds of speech).  Only the first fragment is sent to the LLM (together
 *   with the existing overlap text); subsequent fragments are appended programmatically.
 *   This ensures the LLM never sees more than ~20 seconds of transcript at once.
 *
 * Validation and retry:
 *   After the LLM returns a merged fragment, every word in the result is checked
 *   against the union of words in the two input texts.  If any word in the output is
 *   not found in the inputs, or if the LLM call fails for any reason, the attempt is
 *   retried up to MAX_RETRY_ATTEMPTS times.  If all attempts fail the module falls back
 *   to a simplistic recombination that concatenates both inputs separated by a
 *   "[10-second overlap]" marker.
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

const RECOMBINATION_MODEL = "gpt-4o-mini";

/** Estimated average words per second for splitting text into timed fragments. */
const AVERAGE_WORDS_PER_SECOND = 3;

/** Maximum number of words in a fragment sent to the LLM (~20 seconds of speech). */
const FRAGMENT_MAX_WORDS = 20 * AVERAGE_WORDS_PER_SECOND;

/** Number of LLM call attempts before falling back to simplistic recombination. */
const MAX_RETRY_ATTEMPTS = 5;

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
 * Split text into fragments of at most maxWords words.
 * @param {string} text
 * @param {number} [maxWords]
 * @returns {string[]} Array of fragments; always at least one element.
 */
function splitIntoFragments(text, maxWords = FRAGMENT_MAX_WORDS) {
    const trimmed = text.trim();
    if (!trimmed) {
        return [""];
    }
    const words = trimmed.split(/\s+/);
    /** @type {string[]} */
    const fragments = [];
    for (let i = 0; i < words.length; i += maxWords) {
        fragments.push(words.slice(i, i + maxWords).join(" "));
    }
    return fragments;
}

/**
 * Simplistic fallback recombination when LLM-based merging fails.
 * Returns both inputs concatenated with a "[10-second overlap]" marker.
 * @param {string} existingText
 * @param {string} newText
 * @returns {string}
 */
function simplisticRecombination(existingText, newText) {
    if (!existingText.trim()) {
        return newText;
    }
    if (!newText.trim()) {
        return existingText;
    }
    return `${existingText} [10-second overlap] ${newText}`;
}

/**
 * Single LLM attempt to recombine two overlapping transcript segments.
 * Throws AITranscriptRecombinationError on any failure (API error, empty
 * response, or word-set validation failure).
 * @param {function(string): OpenAI} makeClient - Memoized factory for OpenAI client.
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText - Existing transcript text in the overlap zone.
 * @param {string} newFragment - New fragment of at most FRAGMENT_MAX_WORDS words.
 * @returns {Promise<string>} The recombined text.
 */
async function recombineOverlapRaw(makeClient, capabilities, existingOverlapText, newFragment) {
    const apiKey = capabilities.environment.openaiAPIKey();
    const client = makeClient(apiKey);

    /** @type {Array<{role: "system" | "user", content: string}>} */
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: makeUserPrompt(existingOverlapText, newFragment) },
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
    const allowedWords = makeWordSet(`${existingOverlapText} ${newFragment}`);
    if (!validateWordSubset(rawText, allowedWords)) {
        throw new AITranscriptRecombinationError(
            "Recombined transcript contains words not found in original inputs",
            { existingOverlapText, newFragment, rawText }
        );
    }

    return rawText;
}

/**
 * Recombine a single fragment with retry logic.
 * Tries up to MAX_RETRY_ATTEMPTS times.  Falls back to simplisticRecombination
 * if every attempt throws.
 * @param {function(string): OpenAI} makeClient
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText
 * @param {string} newFragment
 * @returns {Promise<string>}
 */
async function recombineFragmentWithRetry(makeClient, capabilities, existingOverlapText, newFragment) {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            return await recombineOverlapRaw(makeClient, capabilities, existingOverlapText, newFragment);
        } catch {
            // Try again on next iteration; fall through to simplistic on last attempt.
        }
    }
    return simplisticRecombination(existingOverlapText, newFragment);
}

/**
 * Recombine two overlapping transcript segments using an LLM with retry logic.
 *
 * The newWindowText is split into fragments of at most FRAGMENT_MAX_WORDS words
 * (~20 seconds).  The first fragment is merged with existingOverlapText via the
 * LLM (with up to MAX_RETRY_ATTEMPTS retries and a simplistic fallback).
 * Subsequent fragments are appended programmatically without LLM involvement.
 *
 * @param {function(string): OpenAI} makeClient - Memoized factory for OpenAI client.
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText - Existing transcript text in the overlap zone.
 * @param {string} newWindowText - New window transcript text.
 * @returns {Promise<string>} The recombined transcript text.
 */
async function recombineOverlap(makeClient, capabilities, existingOverlapText, newWindowText) {
    const fragments = splitIntoFragments(newWindowText);

    /** @type {string[]} */
    const results = [];
    for (let i = 0; i < fragments.length; i++) {
        const fragment = fragments[i] ?? "";
        if (i === 0) {
            // First fragment: LLM-based recombination (with retry and fallback).
            const merged = await recombineFragmentWithRetry(
                makeClient,
                capabilities,
                existingOverlapText,
                fragment
            );
            results.push(merged);
        } else {
            // Subsequent fragments: append programmatically — no LLM involved.
            results.push(fragment);
        }
    }

    return results.join(" ");
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
    FRAGMENT_MAX_WORDS,
    MAX_RETRY_ATTEMPTS,
    SYSTEM_PROMPT,
    makeUserPrompt,
    makeWordSet,
    validateWordSubset,
    splitIntoFragments,
    simplisticRecombination,
};
