/**
 * Reference conversion for the snapshot migration script.
 *
 * Converts old-format JSON node-key references in inputs/valid values
 * to new-format identifier strings.
 */

/**
 * Check if a string looks like a serialized JSON node key (old format).
 * @param {unknown} str
 * @returns {boolean}
 */
function isOldFormatReference(str) {
    if (typeof str !== "string") return false;
    return str.startsWith('{"head":');
}

/**
 * Convert old-format references in inputs/valid values to identifier strings.
 *
 * Legacy input files wrapped the array in an object under the key "inputs".
 * Any value that is an object with exactly one key "inputs" whose value is
 * an array is unwrapped: the inner array is converted and returned directly,
 * so the output is always a plain array.
 *
 * @param {unknown} value - The parsed JSON value from an inputs or valid file.
 * @param {(nodeKeyJson: string) => string} keyToId - Maps node key JSON -> identifier
 * @returns {unknown} The value with references converted.
 */
function convertReferences(value, keyToId) {
    if (typeof value === "string") {
        if (isOldFormatReference(value)) {
            const id = keyToId(value);
            if (id === undefined) {
                throw new Error(`Cannot find identifier for reference: ${value}`);
            }
            return id;
        }
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => convertReferences(item, keyToId));
    }

    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value);
        // Legacy inputs wrapper: strip the outer object, keep the inner array.
        if (keys.length === 1 && keys[0] === "inputs" && Array.isArray(value.inputs)) {
            return convertReferences(value.inputs, keyToId);
        }
        const result = {};
        for (const [k, v] of Object.entries(value)) {
            result[k] = convertReferences(v, keyToId);
        }
        return result;
    }

    return value;
}

module.exports = { convertReferences };
