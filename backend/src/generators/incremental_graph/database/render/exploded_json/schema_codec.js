/**
 * @file Type-schema parsing, validation, and canonical formatting.
 *
 * Grammar:
 *
 *   TypeSchema =
 *     | "string"
 *     | "number"
 *     | "boolean"
 *     | "null"
 *     | { [objectKey: string]: TypeSchema }
 *     | TypeSchema[]
 *
 * Primitive tokens are JSON strings. Literal JSON values, "object", "array",
 * and "undefined" are invalid schema nodes.
 *
 * Canonical schema files use:
 *   - valid UTF-8 JSON
 *   - two-space indentation for compound schemas
 *   - sorted object keys recursively
 *   - array order unchanged
 *   - no trailing newline
 */

const {
    MalformedTypeSchemaError,
    InvalidTypeSchemaNodeError,
    UnknownTypeSchemaTokenError,
    DuplicateSchemaKeyError,
} = require('./errors');

/**
 * @typedef {string | object | unknown[]} TypeSchema
 */

/**
 * @typedef {"string"|"number"|"boolean"|"null"} PrimitiveSchemaToken
 */

const VALID_PRIMITIVE_TOKENS = new Set(["string", "number", "boolean", "null"]);
const INVALID_TOKENS = new Set(["object", "array", "undefined"]);

/**
 * Validate a type-schema value. Throws if invalid.
 *
 * @param {unknown} schema - The parsed schema value.
 * @param {string} [path] - Current schema path for error messages.
 * @returns {asserts schema is TypeSchema}
 * @throws {InvalidTypeSchemaNodeError|UnknownTypeSchemaTokenError|DuplicateSchemaKeyError}
 */
function validateSchema(schema, path) {
    if (typeof schema === "string") {
        if (VALID_PRIMITIVE_TOKENS.has(schema)) {
            return;
        }
        if (INVALID_TOKENS.has(schema)) {
            throw new UnknownTypeSchemaTokenError(schema);
        }
        throw new InvalidTypeSchemaNodeError(
            `Invalid schema token at ${path || '<root>'}: "${schema}"`,
            schema
        );
    }
    if (typeof schema === "object" && schema !== null) {
        if (Array.isArray(schema)) {
            for (let i = 0; i < schema.length; i++) {
                validateSchema(schema[i], `${path || '<root>'}[${i}]`);
            }
            return;
        }
        const seen = new Set();
        for (const [key, val] of Object.entries(schema)) {
            if (seen.has(key)) {
                throw new DuplicateSchemaKeyError(key);
            }
            seen.add(key);
            validateSchema(val, `${path || '<root>'}.${key}`);
        }
        return;
    }
    if (schema === null || typeof schema === "boolean" || typeof schema === "number") {
        throw new InvalidTypeSchemaNodeError(
            `Literal JSON value at ${path || '<root>'}: ${JSON.stringify(schema)}`,
            schema
        );
    }
    throw new InvalidTypeSchemaNodeError(
        `Invalid schema node at ${path || '<root>'}: ${typeof schema}`,
        schema
    );
}

/**
 * Parse a type-schema text, returning the validated schema value.
 *
 * @param {string} text - The raw file content.
 * @returns {TypeSchema}
 * @throws {MalformedTypeSchemaError|InvalidTypeSchemaNodeError|UnknownTypeSchemaTokenError|DuplicateSchemaKeyError}
 */
function parseSchema(text) {
    let parsed;
    try {
        detectDuplicateKeysInJson(text);
        parsed = JSON.parse(text);
    } catch (err) {
        if (err instanceof DuplicateSchemaKeyError) {
            throw err;
        }
        throw new MalformedTypeSchemaError("Malformed type-schema JSON", err);
    }
    validateSchema(parsed, '');
    return parsed;
}

/**
 * Scan JSON text for duplicate object keys at every nesting level.
 * Throws DuplicateSchemaKeyError if duplicates are found.
 *
 * @param {string} jsonText
 * @returns {void}
 */
function detectDuplicateKeysInJson(jsonText) {
    const stack = [];
    let i = 0;
    while (i < jsonText.length) {
        const ch = jsonText[i];
        if (ch === '{') {
            stack.push({ type: 'object', keys: new Set() });
            i++;
        } else if (ch === '}') {
            if (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (top !== undefined && top.type === 'object') {
                    stack.pop();
                }
            }
            i++;
        } else if (ch === '[') {
            stack.push({ type: 'array' });
            i++;
        } else if (ch === ']') {
            if (stack.length > 0) {
                const top = stack[stack.length - 1];
                if (top !== undefined && top.type === 'array') stack.pop();
            }
            i++;
        } else if (ch === '"') {
            const start = i;
            i++;
            while (i < jsonText.length) {
                if (jsonText[i] === '\\') {
                    i += 2;
                } else if (jsonText[i] === '"') {
                    i++;
                    break;
                } else {
                    i++;
                }
            }
                const afterStr = skipJsonWhitespace(jsonText, i);
                if (afterStr < jsonText.length && jsonText[afterStr] === ':') {
                    const keyStr = jsonText.slice(start, i);
                    const keyContent = JSON.parse(keyStr);
                    if (stack.length > 0) {
                        const top = stack[stack.length - 1];
                        if (top !== undefined && top.type === 'object' && top.keys !== undefined) {
                            if (top.keys.has(keyContent)) {
                                throw new DuplicateSchemaKeyError(keyContent);
                            }
                            top.keys.add(keyContent);
                        }
                    }
                    i = afterStr + 1;
            } else {
                i = afterStr;
            }
        } else {
            i++;
        }
    }
}

/**
 * Skip JSON whitespace characters.
 *
 * @param {string} s
 * @param {number} start
 * @returns {number}
 */
function skipJsonWhitespace(s, start) {
    let i = start;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) {
        i++;
    }
    return i;
}

/**
 * Compute the sorted keys of an object (ascending string code-unit order).
 *
 * @param {object} obj
 * @returns {string[]}
 */
function sortedKeys(obj) {
    return Object.keys(obj).sort();
}

/**
 * Format a validated type schema to canonical JSON text.
 *
 * @param {TypeSchema} schema - Already validated.
 * @returns {string} Canonical schema file content (no trailing newline).
 */
function formatSchema(schema) {
    return JSON.stringify(schema, sortSchemaReplacer, 2);
}

/**
 * JSON.stringify replacer that sorts object keys recursively.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
/**
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function sortSchemaReplacer(_key, value) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        /** @type {Record<string, unknown>} */
        const sorted = {};
        for (const [k, v] of Object.entries(value).sort((a, b) => a[0].localeCompare(b[0]))) {
            sorted[k] = v;
        }
        return sorted;
    }
    return value;
}

/**
 * Determine if a type schema contains any primitive leaves.
 *
 * @param {TypeSchema} schema
 * @returns {boolean}
 */
function schemaHasPrimitiveLeaves(schema) {
    if (typeof schema === "string") {
        return VALID_PRIMITIVE_TOKENS.has(schema);
    }
    if (Array.isArray(schema)) {
        return schema.some(schemaHasPrimitiveLeaves);
    }
    if (typeof schema === "object" && schema !== null) {
        return Object.values(schema).some(schemaHasPrimitiveLeaves);
    }
    return false;
}

module.exports = {
    validateSchema,
    parseSchema,
    formatSchema,
    sortedKeys,
    schemaHasPrimitiveLeaves,
    VALID_PRIMITIVE_TOKENS,
};
