/**
 * Represents an entry returned from the backend API.
 * The constructor validates all required fields to keep the type sound.
 *
 * @typedef {object} EntryData
 * @property {string} id
 * @property {string} date
 * @property {string} type
 * @property {string} description
 * @property {string} input
 * @property {string} original
 * @property {Record<string,string>} [modifiers]
 * @property {object} creator
 */

class EntryClass {
    /** @type {string} */ id;
    /** @type {string} */ date;
    /** @type {string} */ type;
    /** @type {string} */ description;
    /** @type {string} */ input;
    /** @type {string} */ original;
    /** @type {Record<string,string>} */ modifiers;
    /** @type {object} */ creator;
    /** @type {undefined} */ __brand;

    /**
     * @param {EntryData} data
     */
    constructor(data) {
        this.id = data.id;
        this.date = data.date;
        this.type = data.type;
        this.description = data.description;
        this.input = data.input;
        this.original = data.original;
        this.modifiers = data.modifiers || {};
        this.creator = data.creator;
        if (this.__brand !== undefined) {
            throw new Error('Entry is a nominal type');
        }
    }
}

/** @typedef {EntryClass} Entry */

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

    if (!('type' in obj)) throw new Error('Missing type');
    const type = obj.type;
    if (typeof type !== 'string') throw new Error('Invalid type');

    if (!('description' in obj)) throw new Error('Missing description');
    const description = obj.description;
    if (typeof description !== 'string') throw new Error('Invalid description');

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

    const rawModifiers = 'modifiers' in obj ? obj.modifiers : {};
    if (rawModifiers === null || typeof rawModifiers !== 'object' || Array.isArray(rawModifiers)) {
        throw new Error('Invalid modifiers');
    }

    /** @type {Record<string, string>} */
    const validatedModifiers = {};
    for (const [key, value] of Object.entries(rawModifiers)) {
        if (typeof value !== 'string') {
            throw new Error('Modifier values must be strings');
        }
        validatedModifiers[key] = value;
    }

    return new EntryClass({
        id,
        date,
        type,
        description,
        input,
        original,
        modifiers: validatedModifiers,
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

