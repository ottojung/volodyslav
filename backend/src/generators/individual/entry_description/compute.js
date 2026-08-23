/**
 * Computes the description for a specific event.
 *
 * Extracts the typed description text from the event, returning undefined
 * when the event has no meaningful description text.
 */

const { getType, getDescription } = require("../../../event");

/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../incremental_graph/database/types').EntryDescriptionEntry} EntryDescriptionEntry */

/**
 * Returns the text if it is non-empty, otherwise undefined.
 *
 * @param {string | undefined | null} text
 * @returns {string | undefined}
 */
function toDefinedText(text) {
    return text && text.trim() !== "" ? text : undefined;
}

/**
 * Computes the description entry for a given event.
 *
 * @param {Event} event
 * @returns {EntryDescriptionEntry}
 */
function computeEntryDescription(event) {
    if (getType(event) !== "diary") {
        return { type: "entry_description", description: undefined };
    }

    const description = toDefinedText(getDescription(event));
    return { type: "entry_description", description };
}

module.exports = {
    computeEntryDescription,
};
