/**
 * Error classes and helpers for user input processing.
 */

class InputParseErrorClass extends Error {
    /** @type {string} */
    input;

    /**
     * @param {string} message
     * @param {string} input
     */
    constructor(message, input) {
        super(message);
        this.name = "InputParseError";
        this.input = input;
    }
}

class ShortcutApplicationErrorClass extends Error {
    /** @type {string} */
    input;
    /** @type {string} */
    pattern;

    /**
     * @param {string} message
     * @param {string} input
     * @param {string} pattern
     */
    constructor(message, input, pattern) {
        super(message);
        this.name = "ShortcutApplicationError";
        this.input = input;
        this.pattern = pattern;
    }
}

/**
 * Factory for InputParseError.
 * @param {string} message
 * @param {string} input
 * @returns {Error}
 */
function makeInputParseError(message, input) {
    return new InputParseErrorClass(message, input);
}

/**
 * Type guard for InputParseError.
 * @param {unknown} object
 * @returns {object is Error}
 */
function isInputParseError(object) {
    return object instanceof InputParseErrorClass;
}

/**
 * Factory for ShortcutApplicationError.
 * @param {string} message
 * @param {string} input
 * @param {string} pattern
 * @returns {Error}
 */
function makeShortcutApplicationError(message, input, pattern) {
    return new ShortcutApplicationErrorClass(message, input, pattern);
}

/**
 * Type guard for ShortcutApplicationError.
 * @param {unknown} object
 * @returns {object is Error}
 */
function isShortcutApplicationError(object) {
    return object instanceof ShortcutApplicationErrorClass;
}

module.exports = {
    makeInputParseError,
    isInputParseError,
    makeShortcutApplicationError,
    isShortcutApplicationError,
};
