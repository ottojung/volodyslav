/**
 * Incremental-graph database snapshot render/scan module.
 *
 * Provides filesystem rendering (renderToFilesystem) and scanning
 * (scanFromFilesystem) for the incremental-graph database, plus the key
 * encoding helpers used by both operations.
 */

const { keyToRelativePath, relativePathToKey, serializeValue, parseValue } = require('../encoding');
const { renderToFilesystem, renderSublevelToSnapshot } = require('./render');
const { scanFromFilesystem, scanSublevelFromSnapshot, isScanInputDirMissingError } = require('./scan');
const explodedJson = require('./exploded_json');

module.exports = {
    ...explodedJson,
    keyToRelativePath,
    relativePathToKey,
    serializeValue,
    parseValue,
    renderSublevelToSnapshot,
    renderToFilesystem,
    scanSublevelFromSnapshot,
    scanFromFilesystem,
    isScanInputDirMissingError,
};
