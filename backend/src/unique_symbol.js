/**
 * UniqueSymbol provides unique string identifiers for distinguishing operations.
 * 
 * Purpose:
 * - Prevents naming conflicts in concurrent operations
 * - Provides type-safe identifiers that can't be accidentally mixed with regular strings
 * - Supports concatenation to create derived unique identifiers
 */

const randomModule = require("./random");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * Minimal capabilities needed for creating unique symbols
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance
 */

/**
 * Error thrown when attempting to create UniqueSymbol outside module top-level
 */
class UniqueSymbolCreationError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "UniqueSymbolCreationError";
    }
}

/**
 * Type guard for UniqueSymbolCreationError.
 * @param {unknown} object
 * @returns {object is UniqueSymbolCreationError}
 */
function isUniqueSymbolCreationError(object) {
    return object instanceof UniqueSymbolCreationError;
}

class UniqueSymbolClass {
    /**
     * The string value of this unique symbol.
     * @type {string}
     */
    value;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `UniqueSymbol` a nominal type.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {string} value
     */
    constructor(value) {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error('UniqueSymbol value must be a non-empty string');
        }
        this.value = value;
        if (this.__brand !== undefined) {
            throw new Error("UniqueSymbol is a nominal type");
        }
    }

    /**
     * Concatenate this UniqueSymbol with a string to create a new UniqueSymbol
     * @param {string} suffix
     * @returns {UniqueSymbolClass}
     */
    concat(suffix) {
        if (typeof suffix !== 'string') {
            throw new TypeError('Suffix must be a string');
        }
        return new UniqueSymbolClass(this.value + suffix);
    }

    /**
     * Get the string representation of this UniqueSymbol
     * @returns {string}
     */
    toString() {
        return this.value;
    }
}

/** @typedef {UniqueSymbolClass} UniqueSymbol */

/**
 * Type guard for UniqueSymbol.
 * @param {unknown} object
 * @returns {object is UniqueSymbol}
 */
function isUniqueSymbol(object) {
    return object instanceof UniqueSymbolClass;
}

/**
 * Create a new UniqueSymbol with a randomly generated string value.
 * @param {Capabilities} capabilities
 * @param {number} [length=16] - The length of the generated string. Must be a positive integer.
 * @returns {UniqueSymbol}
 */
function makeRandom(capabilities, length = 16) {
    const randomValue = randomModule.string(capabilities, length);
    return new UniqueSymbolClass(randomValue);
}

/**
 * Create a UniqueSymbol from a given string value.
 * @param {string} value
 * @returns {UniqueSymbol}
 */
function fromString(value) {
    return new UniqueSymbolClass(value);
}

module.exports = {
    makeRandom,
    fromString,
    isUniqueSymbol,
    isUniqueSymbolCreationError,
};