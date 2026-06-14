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
        const result = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === "inputs" && Array.isArray(v)) {
                result[k] = v.map((ref) => {
                    if (typeof ref === "string" && isOldFormatReference(ref)) {
                        const id = keyToId(ref);
                        if (id === undefined) {
                            throw new Error(`Cannot find identifier for input reference: ${ref}`);
                        }
                        return id;
                    }
                    return ref;
                });
            } else {
                result[k] = convertReferences(v, keyToId);
            }
        }
        return result;
    }

    return value;
}

module.exports = { convertReferences };
