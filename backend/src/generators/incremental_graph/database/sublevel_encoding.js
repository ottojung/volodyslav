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
 * The name of the sublevel Journal 3 synchronization stages into. Its name is
 * fixed because `$id-4373538486707762` forbids a transport locator in
 * implementation-owned persisted state, and a sublevel name is persisted state
 * an implementation would otherwise be tempted to derive from the peer it is
 * staging from.
 *
 * @type {'sync_staging'}
 */
const SYNC_STAGING_SUBLEVEL_NAME = 'sync_staging';

/**
 * The declared encoding of every sublevel whose name is fixed in this tree.
 *
 * Every replica namespace and the synchronization staging namespace have the
 * same shape, so the table is keyed by the sublevel name alone. It covers the
 * namespace parents as well as the leaves: a namespace parent's own key range
 * is not empty of values for every input — a snapshot can carry a key whose
 * only sublevel name is the parent — and the encoding of that range has to be
 * decided by a recorded entry rather than by a default.
 *
 * @type {Readonly<Record<string, SublevelValueEncoding>>}
 */
const SUBLEVEL_VALUE_ENCODINGS = Object.freeze({
    _meta: 'json',
    x: 'json',
    y: 'json',
    values: 'json',
    freshness: 'json',
    valid: 'json',
    timestamps: 'json',
    global: 'json',
    [SYNC_STAGING_SUBLEVEL_NAME]: ROOT_VALUE_ENCODING,
    [JOURNAL_SUBLEVEL_NAME]: TEXT_VALUE_ENCODING,
});

/**
 * The encoding a namespace parent declares.
 *
 * A namespace parent's encoding is the root's, which is the same answer the
 * table records for the fixed-name parents `x` and `y`.
 *
 * @type {SublevelValueEncoding}
 */
const NAMESPACE_PARENT_VALUE_ENCODING = ROOT_VALUE_ENCODING;

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
 * Thrown when a sublevel is declared whose name the encoding table does not
 * list. The sublevel would then be encoded by whatever the code happens to do
 * by default rather than by a decision anyone recorded, which is the failure
 * mode this guard exists to prevent.
 */
class UndeclaredSublevelValueEncodingError extends Error {
    /** @param {string} sublevelName */
    constructor(sublevelName) {
        super(
            `Sublevel '${sublevelName}' is declared with an encoding, but ` +
            `SUBLEVEL_VALUE_ENCODINGS does not list it. Add '${sublevelName}' to the table with the ` +
            `encoding its values are stored with, so that the raw accessors agree with the declaration.`
        );
        this.name = 'UndeclaredSublevelValueEncodingError';
        this.sublevelName = sublevelName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UndeclaredSublevelValueEncodingError}
 */
function isUndeclaredSublevelValueEncodingError(object) {
    return object instanceof UndeclaredSublevelValueEncodingError;
}

/**
 * The encoding `SUBLEVEL_VALUE_ENCODINGS` records for its own entry
 * `sublevelName`, or `undefined` for a name the table does not list.
 *
 * Membership is decided by an own-property test rather than by reading the entry
 * and comparing it to `undefined`. The table is an ordinary object, so a plain
 * read also answers for every own member of `Object.prototype`: without this
 * test, `declaredValueEncodingForSublevelName('constructor')` answers `[Function:
 * Object]` and the strict accessor's refusal never fires for the eleven names
 * that silently pass the guard. Such a name then reaches abstract-level as a
 * value encoding and fails there with a message about `encoding`, which hides
 * the diagnosis this layer exists to produce.
 *
 * @param {string} sublevelName
 * @returns {SublevelValueEncoding | undefined} The recorded encoding, or
 *   `undefined` when the table has no own entry for the name.
 */
function ownDeclaredValueEncoding(sublevelName) {
    if (!Object.prototype.hasOwnProperty.call(SUBLEVEL_VALUE_ENCODINGS, sublevelName)) {
        return undefined;
    }
    return SUBLEVEL_VALUE_ENCODINGS[sublevelName];
}

/**
 * The declared encoding of a sublevel whose name this tree fixes, and the
 * accessor every sublevel declaration goes through.
 *
 * Unlike `valueEncodingForSublevelName`, this refuses a name the table does not
 * list. A declaration site names a sublevel that exists in this tree, so a name
 * the table does not know is a sublevel whose encoding nobody decided: either a
 * new sublevel added without a table entry, or a typo. Failing the declaration
 * is the only moment at which that is visible, because after the declaration the
 * two sites have already agreed on a wrong encoding and nothing else objects.
 *
 * The raw-key path deliberately does not use this accessor: a raw key's shape is
 * not this layer's to judge, and a key the snapshot layer will reject still has
 * to be stored so that the snapshot layer can produce its own diagnosis.
 *
 * @param {string} sublevelName
 * @returns {SublevelValueEncoding}
 * @throws {UndeclaredSublevelValueEncodingError} If the table does not list the name.
 */
function declaredValueEncodingForSublevelName(sublevelName) {
    const declared = ownDeclaredValueEncoding(sublevelName);
    if (declared === undefined) {
        throw new UndeclaredSublevelValueEncodingError(sublevelName);
    }
    return declared;
}

/**
 * The declared encoding of one named sublevel, falling back to the root
 * encoding for a name the table does not list.
 *
 * This is the lenient lookup, for the raw-key path only: a raw key's shape is
 * not this layer's to judge, so a key naming a sublevel the table does not list
 * still gets an encoding. Membership is an own-property test here too, so a name
 * such as `constructor` falls back to the root encoding rather than resolving to
 * a function where an encoding is required. Declaration sites use
 * `declaredValueEncodingForSublevelName`, which refuses an unlisted name.
 *
 * @param {string} sublevelName
 * @returns {SublevelValueEncoding}
 */
function valueEncodingForSublevelName(sublevelName) {
    return ownDeclaredValueEncoding(sublevelName) ?? ROOT_VALUE_ENCODING;
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
 * The refusal is one-directional: a JSON-valued sublevel stores a text value as a
 * JSON string literal, because every JSON scalar and container is a legitimate
 * value there and refusing by type would break real writes.
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
    NAMESPACE_PARENT_VALUE_ENCODING,
    SYNC_STAGING_SUBLEVEL_NAME,
    ROOT_VALUE_ENCODING,
    SUBLEVEL_VALUE_ENCODINGS,
    TEXT_VALUE_ENCODING,
    SublevelValueEncodingError,
    UndeclaredSublevelValueEncodingError,
    declaredValueEncodingForSublevelName,
    decodeRawValue,
    encodeRawValue,
    isSublevelValueEncodingError,
    isUndeclaredSublevelValueEncodingError,
    valueEncodingForRawKey,
    valueEncodingForSublevelName,
};
