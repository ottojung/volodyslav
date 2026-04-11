/**
 * Incremental-graph database snapshot render/scan module.
 *
 * Provides filesystem rendering (renderToFilesystem) and scanning
 * (scanFromFilesystem) for the incremental-graph database, plus the key
 * encoding helpers used by both operations.
 */

const { keyToRelativePath, relativePathToKey, serializeValue, parseValue } = require('./encoding');

// Export encoding helpers FIRST, before loading render.js or scan.js.
//
// render.js transitively imports ../unification, which imports db_to_fs.js
// and fs_to_db.js.  Both of those modules import from this index.  Node.js
// resolves circular requires by returning the partially-populated exports
// object that exists at the time of the cycle.  By exporting encoding
// functions here — BEFORE the require('./render') call below — the partial
// exports object already contains the functions the unification adapters need,
// so they receive the correct values even mid-cycle.
exports.keyToRelativePath = keyToRelativePath;
exports.relativePathToKey = relativePathToKey;
exports.serializeValue = serializeValue;
exports.parseValue = parseValue;

const { renderToFilesystem } = require('./render');
exports.renderToFilesystem = renderToFilesystem;

const { scanFromFilesystem, isScanInputDirMissingError } = require('./scan');
exports.scanFromFilesystem = scanFromFilesystem;
exports.isScanInputDirMissingError = isScanInputDirMissingError;
