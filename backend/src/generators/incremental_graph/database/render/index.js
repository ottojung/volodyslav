/**
 * Incremental-graph database snapshot render/scan module.
 *
 * Provides filesystem rendering (renderToFilesystem) and scanning
 * (scanFromFilesystem) for the incremental-graph database, plus the key
 * encoding helpers used by both operations.
 */

const { keyToRelativePath, relativePathToKey, serializeValue, parseValue } = require('../encoding');
const { renderToFilesystem } = require('./render');
const { scanFromFilesystem, isScanInputDirMissingError } = require('./scan');

module.exports = {
    keyToRelativePath,
    relativePathToKey,
    serializeValue,
    parseValue,
    renderToFilesystem,
    scanFromFilesystem,
    isScanInputDirMissingError,
};
