/**
 * @typedef {string} RegexPattern
 * A string representing a JavaScript regular expression pattern.
 * Examples: "\\d+", "hello.*world", "^start", "end$", "[a-zA-Z]+"
 */

/**
 * @typedef {string} RegexReplacement
 * A string used as replacement in regex substitution.
 * May contain capture group references like $1, $2, etc.
 * Examples: "NUMBER", "Hello $1", "$1_suffix", "[$2]"
 */

const {
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    InvalidArrayElementError,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
} = require("./errors");

/** @typedef {import("./errors").TryDeserializeError} TryDeserializeError */

/**
 * @typedef Shortcut
 * @type {Object}
 * @property {RegexPattern} pattern - JavaScript regex pattern to match against input text
 * @property {RegexReplacement} replacement - Replacement string, may include capture group refs ($1, $2, etc.)
 * @property {string} [description] - Optional description of what this regex shortcut does
 */

/**
 * @typedef Config
 * @type {Object}
 * @property {string} help - Help text for the configuration
 * @property {Shortcut[]} shortcuts - Array of regex shortcuts with patterns and replacements
 */

/**
 * @typedef {[RegexPattern, RegexReplacement, string?]} SerializedShortcut
 * Array representation of a regex shortcut:
 * - [0]: JavaScript regex pattern string
 * - [1]: Replacement string (may contain $1, $2, etc.)
 * - [2]: Optional description
 */

/**
 * @typedef SerializedConfig
 * @type {Object}
 * @property {string} help - Help text for the configuration
 * @property {SerializedShortcut[]} shortcuts - Array of regex shortcuts as arrays
 */

/**
 * Serializes a regex shortcut to its array representation
 * @param {Shortcut} shortcut - The regex shortcut object to serialize
 * @returns {SerializedShortcut} - The serialized shortcut as an array
 */
function serializeShortcut(shortcut) {
    if (shortcut.description !== undefined) {
        return [shortcut.pattern, shortcut.replacement, shortcut.description];
    }
    return [shortcut.pattern, shortcut.replacement];
}

/**
 * Deserializes a regex shortcut from its array representation
 * @param {SerializedShortcut} serializedShortcut - The serialized shortcut array
 * @returns {Shortcut} - The deserialized regex shortcut object
 */
function deserializeShortcut(serializedShortcut) {
    const [pattern, replacement, description] = serializedShortcut;
    /** @type {Shortcut} */
    const shortcut = { pattern, replacement };
    if (description !== undefined) {
        shortcut.description = description;
    }
    return shortcut;
}

/**
 * @param {Config} config - The config object to serialize
 * @returns {SerializedConfig} - The serialized config object
 */
function serialize(config) {
    return {
        help: config.help,
        shortcuts: config.shortcuts.map(serializeShortcut),
    };
}

/**
 * @param {SerializedConfig} serializedConfig - The serialized config object from JSON
 * @returns {Config} - The deserialized config object
 */
function deserialize(serializedConfig) {
    return {
        help: serializedConfig.help,
        shortcuts: serializedConfig.shortcuts.map(deserializeShortcut),
    };
}

/**
 * Attempts to deserialize an unknown object into a Config.
 * Returns the Config on success, or a TryDeserializeError on failure.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Config | TryDeserializeError} - The deserialized Config or error object
 */
function tryDeserialize(obj) {
    try {
        // Basic type and property checks
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return new InvalidStructureError(
                "Object must be a non-null object and not an array",
                obj
            );
        }

        // Validate help field
        if (!("help" in obj)) return new MissingFieldError("help");
        const help = obj.help;
        if (typeof help !== "string") {
            return new InvalidTypeError("help", help, "string");
        }

        // Validate shortcuts field
        if (!("shortcuts" in obj)) return new MissingFieldError("shortcuts");
        const shortcuts = obj.shortcuts;
        if (!Array.isArray(shortcuts)) {
            return new InvalidTypeError("shortcuts", shortcuts, "array");
        }

        // Validate each shortcut
        /** @type {SerializedShortcut[]} */
        const validatedShortcuts = [];
        for (let i = 0; i < shortcuts.length; i++) {
            const shortcut = shortcuts[i];

            // Each shortcut should be an array
            if (!Array.isArray(shortcut)) {
                return new InvalidArrayElementError("shortcuts", i, shortcut, "expected array");
            }

            // Must have at least 2 elements (regex pattern and replacement)
            if (shortcut.length < 2) {
                return new InvalidArrayElementError("shortcuts", i, shortcut, "must have at least 2 elements (pattern and replacement)");
            }

            // First two elements must be strings (regex pattern and replacement)
            const [pattern, replacement, description] = shortcut;
            if (typeof pattern !== "string") {
                return new InvalidArrayElementError("shortcuts", i, shortcut, "first element (pattern) must be a string");
            }
            if (typeof replacement !== "string") {
                return new InvalidArrayElementError("shortcuts", i, shortcut, "second element (replacement) must be a string");
            }

            // Third element (description) is optional but must be string if present
            if (description !== undefined && typeof description !== "string") {
                return new InvalidArrayElementError("shortcuts", i, shortcut, "third element (description) must be a string if provided");
            }

            // Build validated shortcut after validation
            validatedShortcuts.push([pattern, replacement, description]);
        }

        // Create validated SerializedConfig object
        const validatedSerializedConfig = {
            help,
            shortcuts: validatedShortcuts,
        };

        // Deserialize and return
        return deserialize(validatedSerializedConfig);
    } catch (error) {
        // Wrap any other errors in InvalidValueError
        return new InvalidValueError(
            "unknown",
            obj,
            `Unexpected error during deserialization: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    serializeShortcut,
    deserializeShortcut,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
};
