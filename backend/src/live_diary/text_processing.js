/**
 * Text processing helpers for live diary pipeline.
 *
 * @module live_diary/text_processing
 */

/**
 * @param {string} transcript
 * @returns {{ textForRecombination: string, removedTailWord: string }}
 */
function prepareTranscriptForRecombination(transcript) {
    const trimmed = transcript.trim();
    if (!trimmed) {
        return { textForRecombination: transcript, removedTailWord: "" };
    }

    const words = trimmed.split(/\s+/u);
    const tooFewWords = words.length < 2;
    const removedTailWord = words.pop() || "";
    const tooFewCharsInInitialWords = words.join("").length < 4;
    if (tooFewWords || tooFewCharsInInitialWords) {
        return { textForRecombination: transcript, removedTailWord: "" };
    }

    return {
        textForRecombination: words.join(" "),
        removedTailWord,
    };
}

/**
 * @param {string} recombinedText
 * @param {string} removedTailWord
 * @returns {string}
 */
function appendRemovedTailWord(recombinedText, removedTailWord) {
    if (!removedTailWord) {
        return recombinedText;
    }

    const trimmed = recombinedText.trim();
    if (!trimmed) {
        return removedTailWord;
    }

    return `${trimmed} ${removedTailWord}`;
}

/**
 * @param {Array<{text: string, intent: string}>} questions
 * @param {string[]} askedTexts
 * @returns {Array<{text: string, intent: string}>}
 */
function deduplicateQuestions(questions, askedTexts) {
    const normalise = (/** @type {string} */ s) =>
        s.normalize("NFKD")
            .toLowerCase()
            .replace(/[\p{P}\p{S}]/gu, "")
            .replace(/\s+/g, " ")
            .trim();

    const seen = new Set(askedTexts.map(normalise));
    /** @type {Array<{text: string, intent: string}>} */
    const result = [];
    for (const q of questions) {
        const key = normalise(q.text);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(q);
        }
    }
    return result;
}

module.exports = {
    prepareTranscriptForRecombination,
    appendRemovedTailWord,
    deduplicateQuestions,
};
