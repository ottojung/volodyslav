/**
 * @module transcription_glue
 *
 * Deterministic transcript stitching with overlap detection.
 *
 * Chunks are transcribed with a small audio overlap between adjacent chunks,
 * which means the text output also overlaps.  This module removes the duplicated
 * overlap using token-based matching rather than raw string comparison, so it
 * works for multilingual text and is robust to punctuation/whitespace differences.
 *
 * No side effects – safe to test without mocks.
 */

/** Minimum number of matching words required to accept an overlap. */
const MIN_OVERLAP_WORDS = 2;

/** Maximum number of words to search from each side when looking for overlap. */
const MAX_SEARCH_WORDS = 100;

/**
 * @typedef {object} WordToken
 * @property {string} normalized - Lowercase word with leading/trailing punctuation removed.
 * @property {number} end - Index of the character AFTER this token in the original string.
 */

/**
 * Extract word tokens with their end-positions from text.
 * Unicode-safe: uses `\S+` so non-ASCII scripts are handled naturally.
 * Punctuation attached to words is stripped from the normalised form only;
 * the original text is kept intact for the final output.
 *
 * @param {string} text
 * @returns {WordToken[]}
 */
function extractWords(text) {
    /** @type {WordToken[]} */
    const result = [];
    const regex = /\S+/gu;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const raw = match[0];
        // Strip leading and trailing non-letter / non-digit characters
        const normalized = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (normalized) {
            result.push({ normalized, end: match.index + raw.length });
        }
    }
    return result;
}

/**
 * @typedef {object} OverlapInfo
 * @property {number} overlapWords - Number of word tokens removed from the start of currentText.
 */

/**
 * @typedef {object} GlueResult
 * @property {string} text - The combined text after removing the duplicated overlap.
 * @property {OverlapInfo} overlapInfo - Metadata about the detected overlap.
 */

/**
 * Glue two consecutive chunk transcripts together, removing the audio-overlap duplicate.
 *
 * Algorithm:
 *  1. Tokenize both texts with Unicode-safe word extraction.
 *  2. Search for the longest suffix/prefix match (above MIN_OVERLAP_WORDS).
 *  3. If found, cut the matching prefix from currentText and join.
 *  4. If not found, join with a single space (conservative fallback).
 *
 * @param {string} previousText - The already-accumulated transcript.
 * @param {string} currentText  - The new chunk transcript to append.
 * @returns {GlueResult}
 */
function glueTranscripts(previousText, currentText) {
    if (!previousText.trim()) {
        return { text: currentText, overlapInfo: { overlapWords: 0 } };
    }
    if (!currentText.trim()) {
        return { text: previousText, overlapInfo: { overlapWords: 0 } };
    }

    const prevWords = extractWords(previousText);
    const currWords = extractWords(currentText);

    if (prevWords.length === 0 || currWords.length === 0) {
        return {
            text: previousText + " " + currentText,
            overlapInfo: { overlapWords: 0 },
        };
    }

    const prevSearch = prevWords.slice(-MAX_SEARCH_WORDS);
    const currSearch = currWords.slice(0, MAX_SEARCH_WORDS);

    const maxPossible = Math.min(prevSearch.length, currSearch.length);
    let bestOverlap = 0;

    for (let len = maxPossible; len >= MIN_OVERLAP_WORDS; len--) {
        const prevSuffix = prevSearch.slice(-len);
        const currPrefix = currSearch.slice(0, len);
        const matched = prevSuffix.every((w, idx) => {
            const cw = currPrefix[idx];
            return cw !== undefined && w.normalized === cw.normalized;
        });
        if (matched) {
            bestOverlap = len;
            break;
        }
    }

    if (bestOverlap === 0) {
        // Don't add a separator if prev ends with whitespace or curr starts with whitespace
        const prevEndsWs = /\s$/u.test(previousText);
        const currStartsWs = /^\s/u.test(currentText);
        const separator = prevEndsWs || currStartsWs ? "" : " ";
        return {
            text: previousText + separator + currentText,
            overlapInfo: { overlapWords: 0 },
        };
    }

    // Determine character position where the overlap ends in currentText
    const overlapWord = currWords[bestOverlap - 1];
    const overlapEndChar = overlapWord !== undefined ? overlapWord.end : 0;
    // Skip leading whitespace after the cut point so we don't double-space
    let cutAt = overlapEndChar;
    while (cutAt < currentText.length && /\s/u.test(currentText[cutAt] ?? "")) {
        cutAt++;
    }

    const remaining = currentText.slice(cutAt);
    const prevEndsWs = /\s$/u.test(previousText);
    const remStartsWs = remaining.startsWith("\n");
    const sep = !remaining || prevEndsWs || remStartsWs ? "" : " ";
    return {
        text: previousText + sep + remaining,
        overlapInfo: { overlapWords: bestOverlap },
    };
}

module.exports = {
    glueTranscripts,
    extractWords,
    MIN_OVERLAP_WORDS,
    MAX_SEARCH_WORDS,
};
