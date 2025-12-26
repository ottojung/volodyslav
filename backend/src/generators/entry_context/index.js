/** @typedef {import('../../event').Event} Event */

const { extractHashtags, isContextEnhancing } = require("../../event");

/**
 * This function extracts the basic context of a given entry from a list of all entries.
 *
 * @param {Array<Event>} all_entries
 * @param {Event} entry
 * @returns {Array<Event>} The context of the given entry
 */
function getEntryBasicContext(all_entries, entry) {
    const entryHashtags = extractHashtags(entry);

    // If entry has no hashtags, return only the entry itself
    if (entryHashtags.size === 0) {
        return [entry];
    }

    const context = all_entries.filter((otherEntry) => {
        if (otherEntry.id === entry.id) {
            return true; // Always include the entry itself
        }

        // Check if entry type is context-enhancing
        if (!isContextEnhancing(otherEntry.type)) {
            return false;
        }

        // Check if entry contains some of the same hashtags
        const otherHashtags = extractHashtags(otherEntry);
        for (const hashtag of otherHashtags) {
            if (entryHashtags.has(hashtag)) {
                return true;
            }
        }

        return false;
    });

    if (context.length === 0) {
        return [entry];
    }

    return context;
}

module.exports = {
    getEntryBasicContext,
};
