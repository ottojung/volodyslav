/**
 * @file Value projection flattening and grouping.
 *
 * Converts between ValueProjection and flat virtual file entries.
 */

const { formatSchema } = require('./schema_codec');
const { kindtreeVirtualKey, renderedVirtualKey } = require('./virtual_file_key');

/**
 * @typedef {import('./value_codec').ValueProjection} ValueProjection
 */

/**
 * @typedef {object} VirtualFileEntry
 * @property {string} virtualKey
 * @property {string} content
 */

/**
 * Flatten a ValueProjection for a given value root into virtual file entries.
 *
 * @param {string} valueRoot
 * @param {ValueProjection} projection
 * @returns {VirtualFileEntry[]}
 */
function flattenProjection(valueRoot, projection) {
    const entries = [];
    entries.push({
        virtualKey: kindtreeVirtualKey(valueRoot),
        content: projection.schemaText,
    });
    for (const leaf of projection.leaves) {
        entries.push({
            virtualKey: renderedVirtualKey(valueRoot, leaf.descendantPath),
            content: leaf.content,
        });
    }
    return entries;
}

/**
 * Sort virtual file entries by virtual key (used by unifyStores).
 *
 * @param {VirtualFileEntry[]} entries
 * @returns {VirtualFileEntry[]}
 */
function sortVirtualEntries(entries) {
    return entries.slice().sort((a, b) => {
        if (a.virtualKey < b.virtualKey) return -1;
        if (a.virtualKey > b.virtualKey) return 1;
        return 0;
    });
}

module.exports = {
    flattenProjection,
    sortVirtualEntries,
};
