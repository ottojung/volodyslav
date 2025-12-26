/**
 * @module event/hashtags
 * @description
 * This module provides functionality to extract hashtags from event entries.
 * A hashtag is defined as a word prefixed with the '#' character.
 */

/**
 * Extracts hashtags from a given text.
 * @param {string} text - The text to extract hashtags from.
 * @returns {Set<string>} A set of unique hashtags found in the text.
 */
function extractHashtagsFromText(text) {
    const hashtagRegex = /#((\w|\d)+)/g;
    const hashtags = new Set();
    let match;
    while ((match = hashtagRegex.exec(text)) !== null) {
        hashtags.add(match[1]);
    }
    return hashtags;
}

/**
 * Extracts hashtags from an event entry.
 * @param {import('../event').Event} entry - The event entry to extract hashtags from.
 * @returns {Set<string>} A set of unique hashtags found in the entry's input.
 */
function extractHashtags(entry) {
    const text = entry.input;
    return extractHashtagsFromText(text);
}

module.exports = {
    extractHashtags,
};
