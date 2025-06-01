/**
 * @typedef Shortcut
 * @type {Object}
 * @property {string} pattern - The regex pattern to match against
 * @property {string} replacement - The replacement string
 * @property {string} [description] - Optional description of what the shortcut does
 */

/**
 * @typedef Config
 * @type {Object}
 * @property {string} help - Help text for the configuration
 * @property {Shortcut[]} shortcuts - Array of shortcuts with regex patterns and replacements
 */

/**
 * @typedef {[string, string, string?]} SerializedShortcut
 * Array representation of a shortcut:
 * - [0]: The regex pattern
 * - [1]: The replacement string
 * - [2]: Optional description
 */

/**
 * @typedef SerializedConfig
 * @type {Object}
 * @property {string} help - Help text for the configuration
 * @property {SerializedShortcut[]} shortcuts - Array of shortcuts as arrays
 */

/**
 * Serializes a shortcut to its array representation
 * @param {Shortcut} shortcut - The shortcut object to serialize
 * @returns {SerializedShortcut} - The serialized shortcut as an array
 */
function serializeShortcut(shortcut) {
    if (shortcut.description !== undefined) {
        return [shortcut.pattern, shortcut.replacement, shortcut.description];
    }
    return [shortcut.pattern, shortcut.replacement];
}

/**
 * Deserializes a shortcut from its array representation
 * @param {SerializedShortcut} serializedShortcut - The serialized shortcut array
 * @returns {Shortcut} - The deserialized shortcut object
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
 * Returns null if the object is not a valid SerializedConfig or if deserialization fails.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Config | null} - The deserialized Config or null if invalid
 */
function tryDeserialize(obj) {
    try {
        // Basic type and property checks
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return null;
        }

        // Validate help field
        if (!("help" in obj)) return null;
        const help = obj.help;
        if (typeof help !== "string") {
            return null;
        }

        // Validate shortcuts field
        if (!("shortcuts" in obj)) return null;
        const shortcuts = obj.shortcuts;
        if (!Array.isArray(shortcuts)) {
            return null;
        }

        // Validate each shortcut
        /** @type {SerializedShortcut[]} */
        const validatedShortcuts = [];
        for (let i = 0; i < shortcuts.length; i++) {
            const shortcut = shortcuts[i];

            // Each shortcut should be an array
            if (!Array.isArray(shortcut)) {
                return null;
            }

            // Must have at least 2 elements (pattern and replacement)
            if (shortcut.length < 2) {
                return null;
            }

            // First two elements must be strings
            const [pattern, replacement, description] = shortcut;
            if (
                typeof pattern !== "string" ||
                typeof replacement !== "string"
            ) {
                return null;
            }

            // Third element (description) is optional but must be string if present
            if (description !== undefined && typeof description !== "string") {
                return null;
            }

            // Cast to proper type after validation
            validatedShortcuts.push(
                /** @type {SerializedShortcut} */ (shortcut)
            );
        }

        // Create validated SerializedConfig object
        const validatedSerializedConfig = {
            help,
            shortcuts: validatedShortcuts,
        };

        // Deserialize and return
        return deserialize(validatedSerializedConfig);
    } catch {
        // Any error in deserialization returns null
        return null;
    }
}

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    serializeShortcut,
    deserializeShortcut,
};
