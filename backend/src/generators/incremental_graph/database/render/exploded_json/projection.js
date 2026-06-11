const { projectExplodedJsonValue } = require('./value_codec');
const { makeKindtreeVirtualKey, makeRenderedVirtualKey } = require('./virtual_file_key');
/** @typedef {{key: string, content: string}} VirtualFileEntry */
/** @param {string} valueRoot @param {unknown} value @returns {VirtualFileEntry[]} */
function projectValueRootToVirtualFiles(valueRoot, value) {
    const projection = projectExplodedJsonValue(value);
    return [
        { key: makeKindtreeVirtualKey(valueRoot), content: projection.schemaText },
        ...projection.leaves.map((leaf) => ({ key: makeRenderedVirtualKey(valueRoot, leaf.descendantPath), content: leaf.content })),
    ];
}
module.exports = { projectValueRootToVirtualFiles };
