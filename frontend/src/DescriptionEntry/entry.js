/**
 * Represents an entry returned from the backend API.
 * The constructor validates all required fields to keep the type sound.
 *
 * @typedef {object} EntryData
 * @property {string} id
 * @property {string} date
 * @property {string} input
 * @property {string} original
 * @property {object} creator
 */

class EntryClass {
    /** @type {string} */ id;
    /** @type {string} */ date;
    /** @type {string} */ input;
    /** @type {string} */ original;
    /** @type {object} */ creator;
    /** @type {undefined} */ __brand;

    /**
     * @param {EntryData} data
     */
    constructor(data) {
        this.id = data.id;
        this.date = data.date;
        this.input = data.input;
        this.original = data.original;
        this.creator = data.creator;
        if (this.__brand !== undefined) {
            throw new Error('Entry is a nominal type');
        }
    }
}

/** @typedef {EntryClass} Entry */

/**
 * Parses an input string in the format: TYPE [MODIFIERS...] DESCRIPTION
 * Uses an iterative approach to avoid ReDoS vulnerabilities.
 * @param {string} input
 * @returns {{ type: string, description: string, modifiers: Record<string, string> }}
 */
function parseInput(input) {
    // Step 1: Extract the type (first word starting with a letter)
    const typeMatch = input.match(/^\s*([A-Za-z][A-Za-z0-9]*)/);
    if (!typeMatch) {
        return { type: '', description: input.trim(), modifiers: {} };
    }
    const type = typeMatch[1] ?? '';
    let remainder = input.slice(typeMatch[0].length);

    // Step 2: Extract zero or more modifier tokens from the front.
    // A modifier bracket must start with a letter, e.g. "[key value]" or "[key]" (flag).
    // "[123]" (starts with digit) is left as description.
    /** @type {Record<string, string>} */
    const modifiers = {};
    const modifierPattern = /^\s*\[([A-Za-z]\w*)(?:\s+([^[\]]*))?\]/;
    let modifierMatch = modifierPattern.exec(remainder);
    while (modifierMatch !== null) {
        const key = modifierMatch[1];
        const value = (modifierMatch[2] || '').trim();
        if (key !== undefined) {
            modifiers[key] = value;
        }
        remainder = remainder.slice(modifierMatch[0].length);
        modifierMatch = modifierPattern.exec(remainder);
    }

    // Step 3: Everything left is the description
    const description = remainder.trim();
    return { type, description, modifiers };
}

/**
 * Computes type, description, and modifiers of an entry from its input field in one parse.
 * Prefer this over calling getEntryType/getEntryDescription/getEntryModifiers individually
 * when multiple derived fields are needed.
 * @param {{ input: string }} entry
 * @returns {{ type: string, description: string, modifiers: Record<string, string> }}
 */
export function getEntryParsed(entry) {
    return parseInput(entry.input);
}

/**
 * Computes the type of an entry from its input field.
 * @param {{ input: string }} entry
 * @returns {string}
 */
export function getEntryType(entry) {
    return parseInput(entry.input).type;
}

/**
 * Computes the description of an entry from its input field.
 * @param {{ input: string }} entry
 * @returns {string}
 */
export function getEntryDescription(entry) {
    return parseInput(entry.input).description;
}

/**
 * Computes the modifiers of an entry from its input field.
 * @param {{ input: string }} entry
 * @returns {Record<string, string>}
 */
export function getEntryModifiers(entry) {
    return parseInput(entry.input).modifiers;
}

/**
 * Validates a plain object and constructs an Entry instance.
 * @param {unknown} obj
 * @returns {Entry}
 */
export function makeEntry(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Entry must be an object');
    }

    if (!('id' in obj)) throw new Error('Missing id');
    const id = obj.id;
    if (typeof id !== 'string') throw new Error('Invalid id');

    if (!('date' in obj)) throw new Error('Missing date');
    const date = obj.date;
    if (typeof date !== 'string') throw new Error('Invalid date');

    if (!('input' in obj)) throw new Error('Missing input');
    const input = obj.input;
    if (typeof input !== 'string') throw new Error('Invalid input');

    if (!('original' in obj)) throw new Error('Missing original');
    const original = obj.original;
    if (typeof original !== 'string') throw new Error('Invalid original');

    if (!('creator' in obj)) throw new Error('Missing creator');
    const creator = obj.creator;
    if (!creator || typeof creator !== 'object' || Array.isArray(creator)) {
        throw new Error('Invalid creator');
    }

    return new EntryClass({
        id,
        date,
        input,
        original,
        creator,
    });
}

/**
 * Type guard for Entry objects.
 * @param {unknown} value
 * @returns {value is Entry}
 */
export function isEntry(value) {
    return value instanceof EntryClass;
}

