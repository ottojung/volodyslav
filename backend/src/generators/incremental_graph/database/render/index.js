/**
 * Incremental-graph database snapshot render/scan module.
 *
 * Provides the new exploded JSON snapshot format (renderSublevelToSnapshot /
 * scanSublevelFromSnapshot) and the legacy one-file-JSON format
 * (renderToFilesystem / scanFromFilesystem).
 */

const { keyToRelativePath, relativePathToKey, serializeValue, parseValue } = require('../encoding');
const { renderToFilesystem, renderSublevelToSnapshot } = require('./render');
const { scanFromFilesystem, scanSublevelFromSnapshot, isScanInputDirMissingError } = require('./scan');

module.exports = {
    keyToRelativePath,
    relativePathToKey,
    serializeValue,
    parseValue,
    renderToFilesystem,
    renderSublevelToSnapshot,
    scanFromFilesystem,
    scanSublevelFromSnapshot,
    isScanInputDirMissingError,
};
