
/** @typedef {import('../../event').Event} Event */

/**
 * This function extracts the context of a given entry from a list of all entries.
 * 
 * @param {Array<Event>} _all_entries
 * @param {Event} _entry
 * @returns {Array<Event>} The context of the given entry
 */
function getEntryContext(_all_entries, _entry) {
    // TODO:
    // Search for related entries.
    // An entry is related to this `entry` if:
    // - it is before it in time,
    // - and it contains some of the same hashtags,
    // - and it has type that has property `isContextEnhancing` set to true.
    throw new Error("Not implemented yet");
}

module.exports = {
    getEntryContext,
};
