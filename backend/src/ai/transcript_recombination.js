/**
 * @module ai_transcript_recombination
 *
 * Purpose:
 *   This module provides LLM-based recombination of two partially overlapping 20-second
 *   transcript segments.  The expected inputs are:
 *     - existingOverlapText: transcription of [T-30s, T-10s]
 *     - newWindowText:       transcription of [T-20s, T]
 *   These share a 10-second overlap region [T-20s, T-10s].
 *
 * Validation:
 *   After the LLM returns a merged fragment it is validated with validateCombination,
 *   which asserts that the result can be expressed as:
 *     prefix_of(segment1) + suffix_of(segment2)
 *   i.e. the result starts with a prefix of segment1 and ends with a suffix of segment2
 *   with nothing else in between.  This ensures the LLM only removed overlap words and
 *   did not introduce or rearrange any content.
 *
 * Retry and fallback:
 *   If the LLM call fails or validation fails, the attempt is retried up to
 *   MAX_RETRY_ATTEMPTS times.  After exhaustion, programmaticRecombination is used:
 *   it finds the longest exact word-sequence overlap (modulo capitalisation and
 *   punctuation) between the end of segment1 and the start of segment2 and deduplicates
 *   it.  If no overlap sequence is found, it falls back to the "[10-second overlap]"
 *   concatenation marker.
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

const RECOMBINATION_MODEL = "gpt-5.4-mini";

/** Number of LLM call attempts before falling back to programmatic recombination. */
const MAX_RETRY_ATTEMPTS = 5;

/** Estimated LLM output throughput for chat completions (words per second). */
const LLM_OUTPUT_RATE_WPS = 75;

/**
 * Fixed overhead per API call (ms): network round-trip, queue wait, model initialization.
 * Generous to avoid false positives under API load.
 */
const LLM_CALL_OVERHEAD_MS = 30_000;

/**
 * Count words in a text string.
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Compute a per-attempt timeout for a single recombination API call (ms).
 *
 * The output is validated to be a subset of the combined inputs (no hallucinations),
 * so the output word count is bounded by the sum of input word counts.  Generation
 * time is estimated from that upper bound at LLM_OUTPUT_RATE_WPS words per second,
 * plus a fixed overhead for API latency and queue wait.
 *
 * @param {string} existingOverlapText - Existing transcript covering the overlap zone.
 * @param {string} newFragment - New window transcript text.
 * @returns {number} Timeout in milliseconds.
 */
function computeRecombinationTimeoutMs(existingOverlapText, newFragment) {
    const wordCount = countWords(existingOverlapText) + countWords(newFragment);
    return Math.ceil(wordCount / LLM_OUTPUT_RATE_WPS) * 1_000 + LLM_CALL_OVERHEAD_MS;
}

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
 * Normalise a single word for sequence comparison: lowercase, strip surrounding
 * non-alphanumeric characters but preserve internal apostrophes and hyphens.
 * Internal apostrophes are kept so contractions ("it's") compare equal across
 * inputs.  Internal hyphens are kept so hyphenated words ("twenty-one") compare
 * equal.  All other punctuation (periods, commas, etc.) is removed; this means
 * abbreviations like "U.S.A." are normalised to "usa", which is acceptable for
 * spoken transcript comparison.
 * Returns an empty string for words that are entirely punctuation.
 * @param {string} word
 * @returns {string}
 */
function normalizeWordForComparison(word) {
    return word
        .toLowerCase()
        .replace(/[^a-z0-9'-]/g, "")
        .replace(/^[-']+|[-']+$/g, "");
}

/**
 * Return the words of `text` normalised for sequence comparison.
 * Empty-normalised tokens (pure punctuation) are removed.
 * @param {string} text
 * @returns {string[]}
 */
function normalizedWords(text) {
    return text
        .trim()
        .split(/\s+/)
        .map(normalizeWordForComparison)
        .filter(Boolean);
}

/**
 * Programmatic recombination of two overlapping transcript segments.
 *
 * Finds the longest sequence of consecutive words at the end of segment1 that
 * exactly matches a sequence at the beginning of segment2 (comparison is modulo
 * capitalisation and punctuation).  When found, the overlap is deduplicated: the
 * result keeps all original words of segment1 and appends the words of segment2
 * from just after the matched prefix.
 *
 * Falls back to `"segment1 [10-second overlap] segment2"` when no matching
 * sequence is found.
 *
 * @param {string} segment1
 * @param {string} segment2
 * @returns {string}
 */
function programmaticRecombination(segment1, segment2) {
    if (!segment1.trim()) {
        return segment2;
    }
    if (!segment2.trim()) {
        return segment1;
    }

    const origWords1 = segment1.trim().split(/\s+/);
    const origWords2 = segment2.trim().split(/\s+/);
    const normWords1 = origWords1.map(normalizeWordForComparison);
    const normWords2 = origWords2.map(normalizeWordForComparison);

    const maxLen = Math.min(normWords1.length, normWords2.length);
    for (let len = maxLen; len >= 1; len--) {
        const suffix = normWords1.slice(normWords1.length - len);
        const prefix = normWords2.slice(0, len);

        // Require all words to have non-empty normalised forms so purely
        // punctuation tokens never create a spurious match.
        if (!suffix.every(Boolean) || !prefix.every(Boolean)) {
            continue;
        }

        if (suffix.every((w, i) => w === prefix[i])) {
            // Overlap found: keep all of segment1, append segment2 after the overlap.
            return [...origWords1, ...origWords2.slice(len)].join(" ");
        }
    }

    return `${segment1} [10-second overlap] ${segment2}`;
}

/**
 * Validate that `result` is a valid LLM combination of `segment1` and `segment2`.
 *
 * Asserts that the result can be expressed as:
 *   prefix_of(segment1) + suffix_of(segment2)
 * i.e. there exists a split point such that the words before it (normalised)
 * match a prefix of segment1 and the words from the split onward match a suffix
 * of segment2.  This ensures the LLM only removed overlap content and did not
 * add, rearrange, or hallucinate any words.
 *
 * Comparison is modulo capitalisation and punctuation.
 *
 * @param {string} result
 * @param {string} segment1 - First input segment (existing overlap).
 * @param {string} segment2 - Second input segment (new fragment).
 * @returns {boolean}
 */
function validateCombination(result, segment1, segment2) {
    const resultNorm = normalizedWords(result);
    const words1 = normalizedWords(segment1);
    const words2 = normalizedWords(segment2);

    for (let split = 0; split <= resultNorm.length; split++) {
        // At split > 0, check that the word just added to the prefix still matches
        // segment1.  If not (or if split has exceeded words1.length, in which case
        // words1[split-1] is undefined and the inequality is always true), all larger
        // splits will also fail, so break early.
        if (split > 0 && resultNorm[split - 1] !== words1[split - 1]) {
            break;
        }

        // The remaining words must match a suffix of segment2.
        const suffix = resultNorm.slice(split);
        if (suffix.length > words2.length) {
            continue;
        }
        const offset = words2.length - suffix.length;
        const suffixMatch = suffix.every((w, i) => w === words2[offset + i]);
        if (suffixMatch) {
            return true;
        }
    }

    return false;
}

/**
 * Single LLM attempt to recombine two overlapping transcript segments.
 * Throws AITranscriptRecombinationError on any failure (API error, empty
 * response, or word-set validation failure).
 * @param {function(string): OpenAI} makeClient - Memoized factory for OpenAI client.
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText - Existing transcript text in the overlap zone.
 * @param {string} newFragment - New fragment of at most FRAGMENT_MAX_WORDS words.
 * @param {AbortSignal} signal - Abort signal for cancellation.
 * @returns {Promise<string>} The recombined text.
 */
async function recombineOverlapRaw(makeClient, capabilities, existingOverlapText, newFragment, signal) {
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
        }, { signal });
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

    // Validate: result must be a valid combination of the two input segments.
    // It must equal prefix_of(segment1) + suffix_of(segment2) — no hallucinations,
    // no rearrangements, only the overlap removed.
    if (!validateCombination(rawText, existingOverlapText, newFragment)) {
        throw new AITranscriptRecombinationError(
            "Recombined transcript does not form a valid combination of the input segments",
            { existingOverlapText, newFragment, rawText }
        );
    }

    return rawText;
}

/**
 * Recombine a single fragment with retry logic.
 * Tries up to MAX_RETRY_ATTEMPTS times.  Each individual attempt is bounded
 * by a per-call timeout computed from the actual input sizes — if a single
 * call does not complete in time, the attempt is aborted and the loop retries
 * with a fresh controller.
 * Falls back to programmaticRecombination if every attempt fails or times out.
 * @param {function(string): OpenAI} makeClient
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText
 * @param {string} newFragment
 * @returns {Promise<string>}
 */
async function recombineFragmentWithRetry(makeClient, capabilities, existingOverlapText, newFragment) {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        const timeoutMs = computeRecombinationTimeoutMs(existingOverlapText, newFragment);
        const attemptController = new AbortController();
        const timerId = setTimeout(
            () => attemptController.abort(),
            timeoutMs
        );
        try {
            return await recombineOverlapRaw(makeClient, capabilities, existingOverlapText, newFragment, attemptController.signal);
        } catch {
            // Timed out or API error — retry with a fresh attempt controller.
        } finally {
            clearTimeout(timerId);
        }
    }
    return programmaticRecombination(existingOverlapText, newFragment);
}

/**
 * Recombine two overlapping transcript segments using an LLM with retry logic.
 *
 * Both inputs are transcriptions of two pull-cycle windows that share an
 * overlap region.  Each attempt is bounded by a per-call timeout derived from
 * the actual word count of the inputs via computeRecombinationTimeoutMs.
 *
 * Up to MAX_RETRY_ATTEMPTS are made; if all attempts fail or time out the
 * function falls back to programmaticRecombination and never throws.
 *
 * @param {function(string): OpenAI} makeClient - Memoized factory for OpenAI client.
 * @param {Capabilities} capabilities
 * @param {string} existingOverlapText - Existing transcript text in the overlap zone.
 * @param {string} newWindowText - New window transcript text.
 * @returns {Promise<string>} The recombined transcript text.
 */
async function recombineOverlap(makeClient, capabilities, existingOverlapText, newWindowText) {
    return recombineFragmentWithRetry(makeClient, capabilities, existingOverlapText, newWindowText);
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
    const makeClient = memoize(/** @param {string} apiKey */ (apiKey) => new OpenAI({ apiKey }));
    return {
        recombineOverlap: (existingOverlapText, newWindowText) =>
            recombineOverlap(makeClient, getCapabilitiesMemo(), existingOverlapText, newWindowText),
    };
}

module.exports = {
    make,
    isAITranscriptRecombinationError,
    RECOMBINATION_MODEL,
    MAX_RETRY_ATTEMPTS,
    computeRecombinationTimeoutMs,
    SYSTEM_PROMPT,
    makeUserPrompt,
    makeWordSet,
    validateWordSubset,
    programmaticRecombination,
    validateCombination,
};
