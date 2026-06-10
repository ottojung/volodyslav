/**
 * @file JSON object-key path segment codec.
 *
 * Object keys are encoded as single filesystem path segments using the existing
 * snapshot segment escaping rules, extended with %00 for the empty key.
 *
 * Interpretation is schema-contextual:
 *   - under a schema object -> every child segment decodes as an object key
 *   - under a schema array  -> every child segment is a canonical index
 */

const { DuplicateDecodedPathError } = require('./errors');

const EMPTY_SEGMENT_SENTINEL = '%00';
const DOT_SEGMENT_SENTINEL = '%2E';
const DOT_DOT_SEGMENT_SENTINEL = '%2E%2E';

/**
 * Encode a single object key to a canonical filesystem path segment.
 *
 * @param {string} key - The decoded object key.
 * @returns {string} Canonical path segment.
 */
function encodeObjectKey(key) {
    if (key === '') {
        return EMPTY_SEGMENT_SENTINEL;
    }
    if (key === '.') {
        return DOT_SEGMENT_SENTINEL;
    }
    if (key === '..') {
        return DOT_DOT_SEGMENT_SENTINEL;
    }
    return key
        .replace(/%/g, '%25')
        .replace(/\//g, '%2F')
        .replace(/!/g, '%21');
}

/**
 * Decode a filesystem path segment back to an object key.
 * Accepts both uppercase and lowercase escape forms.
 *
 * @param {string} segment - The path segment.
 * @returns {string} Decoded object key.
 */
function decodeObjectKey(segment) {
    if (/^%00$/i.test(segment)) return '';
    if (/^%2e$/i.test(segment)) return '.';
    if (/^%2e%2e$/i.test(segment)) return '..';
    return segment
        .replace(/%21/gi, '!')
        .replace(/%2F/gi, '/')
        .replace(/%25/gi, '%');
}

/**
 * Validate and canonicalize an array index segment.
 *
 * @param {string} segment - The path segment.
 * @returns {string} Returns the segment unchanged if valid.
 * @throws {Error} If the segment is not a canonical array index.
 */
function validateArrayIndex(segment) {
    if (segment === '0') {
        return segment;
    }
    if (/^[1-9][0-9]*$/.test(segment)) {
        return segment;
    }
    throw new Error(`Invalid array index: ${segment}`);
}

/**
 * Check whether a set of decoded keys has duplicates (case-insensitive escape
 * collisions).
 *
 * @param {string} valueRoot - For error reporting.
 * @param {string[]} decodedSegments - Already-decoded object key segments.
 * @throws {DuplicateDecodedPathError}
 */
function rejectDuplicateDecodedKeys(valueRoot, decodedSegments) {
    const seen = new Map();
    for (const decoded of decodedSegments) {
        if (seen.has(decoded)) {
            const variants = seen.get(decoded);
            variants.push(decoded);
            throw new DuplicateDecodedPathError(valueRoot, decoded, variants);
        }
        seen.set(decoded, [decoded]);
    }
}

module.exports = {
    encodeObjectKey,
    decodeObjectKey,
    validateArrayIndex,
    rejectDuplicateDecodedKeys,
};
