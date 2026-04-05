/**
 * Incremental-graph database snapshot render/scan module.
 *
 * Provides filesystem rendering (renderToFilesystem) and scanning
 * (scanFromFilesystem) for the incremental-graph database, plus the key
 * encoding helpers used by both operations.
 */

const { renderToFilesystem } = require('./render');
const { scanFromFilesystem } = require('./scan');
const { keyToRelativePath, relativePathToKey, serializeValue, parseValue } = require('./encoding');

module.exports = {
    renderToFilesystem,
    scanFromFilesystem,
    keyToRelativePath,
    relativePathToKey,
    serializeValue,
    parseValue,
};
