const path = require('path');
const KIND_MARKER = '\x00k\x00';
const RENDERED_MARKER = '\x00r\x00';

/** @param {string} valueRoot @returns {string} */
function makeKindtreeVirtualKey(valueRoot) { return valueRoot + KIND_MARKER; }
/** @param {string} valueRoot @param {string} descendantPath @returns {string} */
function makeRenderedVirtualKey(valueRoot, descendantPath) { return valueRoot + RENDERED_MARKER + descendantPath; }

/** @param {string} snapshotRoot @param {string} virtualKey @returns {string} */
function virtualKeyToPhysicalPath(snapshotRoot, virtualKey) {
    const kindIndex = virtualKey.indexOf(KIND_MARKER);
    if (kindIndex >= 0) return path.join(snapshotRoot, 'kindtree', virtualKey.slice(0, kindIndex));
    const renderedIndex = virtualKey.indexOf(RENDERED_MARKER);
    if (renderedIndex >= 0) {
        const valueRoot = virtualKey.slice(0, renderedIndex);
        const descendantPath = virtualKey.slice(renderedIndex + RENDERED_MARKER.length);
        return path.join(snapshotRoot, 'rendered', valueRoot, descendantPath);
    }
    throw new InvalidVirtualFileKeyError(virtualKey);
}

class InvalidVirtualFileKeyError extends Error {
    /** @param {string} virtualKey */
    constructor(virtualKey) {
        super(`Invalid exploded JSON virtual file key: '${virtualKey}'`);
        this.name = 'InvalidVirtualFileKeyError';
        this.virtualKey = virtualKey;
    }
}
/** @param {unknown} object @returns {object is InvalidVirtualFileKeyError} */
function isInvalidVirtualFileKeyError(object) { return object instanceof InvalidVirtualFileKeyError; }
module.exports = { KIND_MARKER, RENDERED_MARKER, makeKindtreeVirtualKey, makeRenderedVirtualKey, virtualKeyToPhysicalPath, isInvalidVirtualFileKeyError };
