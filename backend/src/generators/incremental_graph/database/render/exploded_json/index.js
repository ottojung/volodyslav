/**
 * @file Exploded JSON value rendering module.
 *
 * Public exports for the exploded JSON value codec and its supporting modules.
 */

const { projectExplodedJsonValue, scanExplodedJsonProjection } = require('./value_codec');
const { parseSchema, formatSchema, validateSchema, schemaHasPrimitiveLeaves } = require('./schema_codec');
const { formatPrimitive, parseNumber, parseBoolean, parseNull } = require('./scalar_codec');
const { encodeObjectKey, decodeObjectKey, validateArrayIndex } = require('./path_codec');
const { kindtreeVirtualKey, renderedVirtualKey, parseVirtualKey, virtualKeyToPhysicalPath } = require('./virtual_file_key');
const { flattenProjection, sortVirtualEntries } = require('./projection');
const { jsonStructuralEquals } = require('./value_equality');

module.exports = {
    projectExplodedJsonValue,
    scanExplodedJsonProjection,
    parseSchema,
    formatSchema,
    validateSchema,
    schemaHasPrimitiveLeaves,
    formatPrimitive,
    parseNumber,
    parseBoolean,
    parseNull,
    encodeObjectKey,
    decodeObjectKey,
    validateArrayIndex,
    kindtreeVirtualKey,
    renderedVirtualKey,
    parseVirtualKey,
    virtualKeyToPhysicalPath,
    flattenProjection,
    sortVirtualEntries,
    jsonStructuralEquals,
};
