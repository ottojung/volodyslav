/**
 * @file Internal virtual file key ordering.
 *
 * Virtual keys allow unifyStores() to operate over a sorted flat key space
 * while preserving the paired value-projection unit.
 *
 * Format:
 *
 *   <value-root>\x00k\x00               -> kindtree/<value-root>
 *   <value-root>\x00r\x00               -> rendered/<value-root> (scalar root)
 *   <value-root>\x00r\x00<descendant>   -> rendered/<value-root>/<descendant>
 *
 * Separator \x00 is chosen because it sorts before any printable ASCII
 * character, so all keys for one value root cluster together.
 */

const VK_SEP = '\x00';

/**
 * @typedef {"k"|"r"} VirtualKeyTree
 */

/**
 * Build a virtual key for a kindtree schema file.
 *
 * @param {string} valueRoot - The value-root path.
 * @returns {string}
 */
function kindtreeVirtualKey(valueRoot) {
    return `${valueRoot}${VK_SEP}k${VK_SEP}`;
}

/**
 * Build a virtual key for a rendered primitive leaf file.
 *
 * @param {string} valueRoot - The value-root path.
 * @param {string} [descendantPath] - The descendant path (empty for scalar root).
 * @returns {string}
 */
function renderedVirtualKey(valueRoot, descendantPath) {
    return `${valueRoot}${VK_SEP}r${VK_SEP}${descendantPath || ''}`;
}

/**
 * Parse a virtual key into its components.
 *
 * @param {string} virtualKey
 * @returns {{ valueRoot: string, tree: VirtualKeyTree, descendantPath: string }|null}
 */
function parseVirtualKey(virtualKey) {
    const sepIndex = virtualKey.indexOf(VK_SEP);
    if (sepIndex === -1) return null;
    const valueRoot = virtualKey.slice(0, sepIndex);
    const rest = virtualKey.slice(sepIndex + 1);
    if (rest.length < 2 || rest[1] !== VK_SEP) return null;
    const tree = rest[0];
    if (tree !== 'k' && tree !== 'r') return null;
    const descendantPath = rest.slice(2);
    return { valueRoot, tree, descendantPath };
}

/**
 * Convert a virtual key to a physical filesystem path under the snapshot root.
 *
 * @param {string} virtualKey
 * @param {string} snapshotSublevel - The snapshot sublevel (e.g. "r").
 * @returns {string} Relative path like "kindtree/r/..." or "rendered/r/..."
 */
function virtualKeyToPhysicalPath(virtualKey, snapshotSublevel) {
    const parsed = parseVirtualKey(virtualKey);
    if (!parsed) {
        throw new Error(`Invalid virtual key: ${virtualKey}`);
    }
    const { valueRoot, tree, descendantPath } = parsed;
    if (tree === 'k') {
        return `kindtree/${snapshotSublevel}/${valueRoot}`;
    }
    if (descendantPath) {
        return `rendered/${snapshotSublevel}/${valueRoot}/${descendantPath}`;
    }
    return `rendered/${snapshotSublevel}/${valueRoot}`;
}

module.exports = {
    kindtreeVirtualKey,
    renderedVirtualKey,
    parseVirtualKey,
    virtualKeyToPhysicalPath,
    VK_SEP,
};
