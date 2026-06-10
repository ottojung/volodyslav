/**
 * @file Scalar formatting and parsing for exploded JSON value rendering.
 *
 * Canonical rendered text for each primitive:
 *
 *   string  -> exact string text, no JSON quoting or trimming
 *   number  -> canonical JSON number text
 *   boolean -> exactly "true" or "false"
 *   null    -> exactly "null"
 *
 * Scanning tolerates:
 *   - valid noncanonical number spellings (e.g. 1.0, 1e0) -> canonicalized
 *   - single final LF after number, boolean, null -> canonicalized away
 *
 * Strings preserve content exactly, including final newlines.
 */

const {
    InvalidNumberLeafError,
    InvalidBooleanLeafError,
    InvalidNullLeafError,
} = require('./errors');

/**
 * @typedef {"string"|"number"|"boolean"|"null"} PrimitiveType
 */

/**
 * Format a primitive value to its canonical rendered text.
 *
 * @param {unknown} value - The JavaScript value.
 * @param {PrimitiveType} type - The expected primitive type.
 * @returns {string} Canonical rendered text.
 */
function formatPrimitive(value, type) {
    switch (type) {
        case "string":
            return String(value);
        case "number":
            return formatNumber(/** @type {number} */ (value));
        case "boolean":
            return value ? "true" : "false";
        case "null":
            return "null";
        default:
            throw new Error(`Unknown primitive type: ${type}`);
    }
}

/**
 * Format a number to canonical JSON number text.
 *
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
    if (Object.is(value, -0)) {
        return "0";
    }
    return JSON.stringify(value);
}

/**
 * Parse a rendered leaf text for a number primitive.
 *
 * @param {string} content - The file content.
 * @param {string | undefined} [valueRoot] - For error reporting.
 * @param {string | undefined} [leafPath] - For error reporting.
 * @returns {number}
 * @throws {InvalidNumberLeafError}
 */
function parseNumber(content, valueRoot, leafPath) {
    const trimmed = trimSingleFinalLF(content);
    if (trimmed.length === 0) {
        throw new InvalidNumberLeafError(valueRoot, leafPath, content);
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        throw new InvalidNumberLeafError(valueRoot, leafPath, content);
    }
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
        throw new InvalidNumberLeafError(valueRoot, leafPath, content);
    }
    return parsed;
}

/**
 * Parse a rendered leaf text for a boolean primitive.
 *
 * @param {string} content - The file content.
 * @param {string} [valueRoot] - For error reporting.
 * @param {string} [leafPath] - For error reporting.
 * @returns {boolean}
 * @throws {InvalidBooleanLeafError}
 */
function parseBoolean(content, valueRoot, leafPath) {
    const trimmed = trimSingleFinalLF(content);
    if (trimmed === "true") {
        return true;
    }
    if (trimmed === "false") {
        return false;
    }
    throw new InvalidBooleanLeafError(valueRoot, leafPath, content);
}

/**
 * Parse a rendered leaf text for a null primitive.
 *
 * @param {string} content - The file content.
 * @param {string} [valueRoot] - For error reporting.
 * @param {string} [leafPath] - For error reporting.
 * @returns {null}
 * @throws {InvalidNullLeafError}
 */
function parseNull(content, valueRoot, leafPath) {
    const trimmed = trimSingleFinalLF(content);
    if (trimmed === "null") {
        return null;
    }
    throw new InvalidNullLeafError(valueRoot, leafPath, content);
}

/**
 * If content ends with exactly one LF, strip it.
 * Returns the content unchanged if it does not end with LF,
 * or if it ends with multiple LFs or other whitespace.
 *
 * @param {string} content
 * @returns {string}
 */
function trimSingleFinalLF(content) {
    if (content.endsWith("\n")) {
        const withoutLF = content.slice(0, -1);
        if (!withoutLF.endsWith("\n")) {
            return withoutLF;
        }
    }
    return content;
}

module.exports = {
    formatPrimitive,
    formatNumber,
    parseNumber,
    parseBoolean,
    parseNull,
    trimSingleFinalLF,
};
