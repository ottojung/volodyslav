/**
 * The single place that decides how each sublevel's values are encoded on disk.
 *
 * The Journal sublevel stores canonical text, not JSON values: `journal/state`
 * and `journal/record|...` hold `JSON.stringify(...)` output that the Journal's
 * current-format readers parse themselves, and `journal/occurrence|...` holds a
 * bare `author:sequence` record id which is not JSON at all. Every other sublevel
 * stores JSON values.
 *
 * That makes the Journal sublevel the only sublevel which cannot be read or
 * written through the untyped root instance with the root's own `json` encoding.
 * The raw accessors on `RootDatabase` (`_rawEntries`, `_rawGetInSublevel`,
 * `_rawPut`, ...) cross the whole key space of a top-level sublevel at once, and
 * abstract-level applies one encoding to every value an iterator or a `get`
 * returns, including values that belong to a nested sublevel. They therefore read
 * and write through the text encoding and apply the per-sublevel encoding
 * themselves, which is what this module provides.
 */

const { journalTextToString, stringToJournalText } = require('./types');

/** @typedef {import('./types').JournalText} JournalText */

/**
 * The value encoding a sublevel's entries are stored with.
 *
 * - `json` means the stored bytes are a JSON document and the decoded value is
 *   the structure it describes.
 * - `utf8` means the stored bytes are the value itself, as text.
 *
 * @typedef {'json' | 'utf8'} SublevelValueEncoding
 */

/**
 * The encoding the root LevelDB instance itself uses. A sublevel inherits it
 * unless `SUBLEVEL_VALUE_ENCODINGS` names the sublevel.
 *
 * @type {SublevelValueEncoding}
 */
const ROOT_VALUE_ENCODING = 'json';

/**
 * The encoding every text-valued sublevel uses.
 *
 * @type {SublevelValueEncoding}
 */
const TEXT_VALUE_ENCODING = 'utf8';

/**
 * The Journal sublevel's name. It is the only sublevel whose values are text,
 * because the Journal's canonical record text and its bare record ids are the
 * values themselves rather than JSON documents describing something else.
 *
 * @type {'journal'}
 */
const JOURNAL_SUBLEVEL_NAME = 'journal';

/**
 * The declared encoding of every named sublevel. Every replica namespace and
 * every hostname staging namespace has this shape, so the table is keyed by the
 * sublevel name alone.
 *
 * @type {Readonly<Record<string, SublevelValueEncoding>>}
 */
const SUBLEVEL_VALUE_ENCODINGS = Object.freeze({
    values: 'json',
    freshness: 'json',
    valid: 'json',
    timestamps: 'json',
    global: 'json',
    [JOURNAL_SUBLEVEL_NAME]: TEXT_VALUE_ENCODING,
});

/**
 * Thrown when a value cannot be stored in the sublevel the key names, because
 * the two disagree about the kind of value the sublevel holds.
 */
class SublevelValueEncodingError extends Error {
    /**
     * @param {string} rawKey
     * @param {SublevelValueEncoding} valueEncoding
     * @param {string} actual
     */
    constructor(rawKey, valueEncoding, actual) {
        super(
            `Cannot store a ${actual} value at '${rawKey}': the sublevel that key names stores ` +
            `values as ${valueEncoding} text, so storing it would change what the value means`
        );
        this.name = 'SublevelValueEncodingError';
        this.rawKey = rawKey;
        this.valueEncoding = valueEncoding;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SublevelValueEncodingError}
 */
function isSublevelValueEncodingError(object) {
    return object instanceof SublevelValueEncodingError;
}

/**
 * The declared encoding of one named sublevel.
 *
 * A name the table does not list inherits the root encoding, because the root
 * instance is where such a sublevel's parent opened it.
 *
 * @param {string} sublevelName
 * @returns {SublevelValueEncoding}
 */
function valueEncodingForSublevelName(sublevelName) {
    return SUBLEVEL_VALUE_ENCODINGS[sublevelName] ?? ROOT_VALUE_ENCODING;
}

/**
 * The name of the sublevel a raw LevelDB key belongs to, which is the innermost
 * of the `!`-separated names the key is built from.
 *
 * This reads the key's shape without judging it: a key whose shape is malformed
 * still names a sublevel, and deciding that a key is malformed is the job of the
 * snapshot layer (`encoding.js`), not of the layer that has to know how the value
 * under that key is stored. Deciding the encoding of a key the snapshot layer will
 * later reject is harmless; rejecting it here would hide the snapshot layer's own
 * diagnosis.
 *
 * @param {string} rawKey
 * @returns {string | undefined} The innermost name, or `undefined` for a key which
 *   names no sublevel at all.
 */
function innermostSublevelName(rawKey) {
    /** @type {string[]} */
    const names = [];
    let current = '';
    // A single '!' terminates a sublevel name and starts the key content, so
    // whatever follows the last such terminator is the key, not a name.
    let keyContentStarted = false;
    for (let i = 0; i < rawKey.length; i += 1) {
        if (rawKey[i] !== '!') {
            current += rawKey[i];
            continue;
        }
        if (current !== '') {
            names.push(current);
        }
        if (i + 1 < rawKey.length && rawKey[i + 1] === '!') {
            i += 1;
        } else {
            keyContentStarted = true;
        }
        current = '';
    }
    if (current !== '' && !keyContentStarted) {
        names.push(current);
    }
    return names[names.length - 1];
}

/**
 * The declared encoding of the sublevel a raw LevelDB key belongs to.
 *
 * @param {string} rawKey
 * @returns {SublevelValueEncoding}
 */
function valueEncodingForRawKey(rawKey) {
    const innermost = innermostSublevelName(rawKey);
    if (innermost === undefined) {
        return ROOT_VALUE_ENCODING;
    }
    return valueEncodingForSublevelName(innermost);
}

/**
 * Decode one value that was read as text through the root instance, into the
 * value the sublevel that key names holds.
 *
 * Text-valued sublevels yield `JournalText`, because the Journal sublevel is the
 * only text-valued sublevel and its text is Journal text by construction.
 *
 * @param {string} rawKey
 * @param {string} text
 * @returns {unknown}
 * @throws {SyntaxError} If a JSON-valued sublevel holds bytes that are not JSON.
 */
function decodeRawValue(rawKey, text) {
    if (valueEncodingForRawKey(rawKey) === TEXT_VALUE_ENCODING) {
        return stringToJournalText(text);
    }
    return JSON.parse(text);
}

/**
 * Prepare one value for storage under a raw LevelDB key: report the encoding
 * the key's sublevel stores with, and reject a value that encoding cannot hold.
 *
 * @param {string} rawKey
 * @param {unknown} value
 * @returns {{ valueEncoding: SublevelValueEncoding, value: unknown }}
 * @throws {SublevelValueEncodingError} If a text-valued sublevel is handed a
 *   value that is not text. Storing it would replace the value with its
 *   `String(...)` form, which is not the value any reader of that sublevel
 *   expects.
 */
function encodeRawValue(rawKey, value) {
    const valueEncoding = valueEncodingForRawKey(rawKey);
    if (valueEncoding === TEXT_VALUE_ENCODING) {
        if (typeof value !== 'string') {
            throw new SublevelValueEncodingError(rawKey, valueEncoding, typeof value);
        }
        return { valueEncoding, value: journalTextToString(stringToJournalText(value)) };
    }
    return { valueEncoding, value };
}

module.exports = {
    JOURNAL_SUBLEVEL_NAME,
    ROOT_VALUE_ENCODING,
    SUBLEVEL_VALUE_ENCODINGS,
    TEXT_VALUE_ENCODING,
    SublevelValueEncodingError,
    decodeRawValue,
    encodeRawValue,
    isSublevelValueEncodingError,
    valueEncodingForRawKey,
    valueEncodingForSublevelName,
};