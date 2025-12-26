/** @typedef {import('../../event').Event} Event */

const { extractHashtags, isContextEnhancing } = require("../../event");

/**
 * This function extracts the context of a given entry from a list of all entries.
 *
 * @param {Array<Event>} all_entries
 * @param {Event} entry
 * @returns {Array<Event>} The context of the given entry
 */
function getEntryContext(all_entries, entry) {
    const entryHashtags = extractHashtags(entry);

    // If entry has no hashtags, return empty context
    if (entryHashtags.size === 0) {
        return [];
    }

    const context = all_entries.filter((otherEntry) => {
        // Skip the entry itself
        if (otherEntry.id === entry.id) {
            return false;
        }

        // Check if entry is before the target entry in time
        if (!otherEntry.date.isBefore(entry.date)) {
            return false;
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

    return context;
}

module.exports = {
    getEntryContext,
};
