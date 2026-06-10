/**
 * @file Exploded JSON value codec.
 *
 * Pure codec that converts between supported DB values and their paired
 * projection (type schema + rendered primitive leaf files). Knows nothing
 * about LevelDB, Git, replica cutover, or physical filesystem writes.
 *
 * Supported values:
 *   string, finite JSON-representable number, boolean, null,
 *   plain object with string keys, non-sparse array
 */

const { formatPrimitive, parseNumber, parseBoolean, parseNull } = require('./scalar_codec');
const { formatSchema } = require('./schema_codec');
const { encodeObjectKey } = require('./path_codec');
const {
    UnsupportedRenderedValueError,
    CycleInRenderedValueError,
    SparseArrayRenderedValueError,
    NonPlainObjectRenderedValueError,
} = require('./errors');

/**
 * @typedef {object} RenderedLeaf
 * @property {string} descendantPath - Relative path below value root; "" for scalar root.
 * @property {string} content - Canonical rendered text.
 */

/**
 * @typedef {object} ValueProjection
 * @property {import('./schema_codec').TypeSchema} schema - The validated type schema.
 * @property {string} schemaText - Canonical schema file content.
 * @property {RenderedLeaf[]} leaves - Primitive leaf files.
 */

/**
 * Project a supported DB value into its paired value projection.
 *
 * @param {unknown} value - The DB value to render.
 * @param {Set<object>} [cycleDetector] - Internal use for cycle detection.
 * @returns {ValueProjection}
 * @throws {UnsupportedRenderedValueError|CycleInRenderedValueError|SparseArrayRenderedValueError|NonPlainObjectRenderedValueError}
 */
function projectExplodedJsonValue(value, cycleDetector) {
    const detector = cycleDetector || new Set();
    const schema = buildSchema(value, detector);
    const leaves = buildLeaves(value, "", detector);
    return {
        schema,
        schemaText: formatSchema(schema),
        leaves,
    };
}

/**
 * Build a type schema for a value.
 *
 * @param {unknown} value
 * @param {Set<object>} cycleDetector
 * @returns {import('./schema_codec').TypeSchema}
 */
function buildSchema(value, cycleDetector) {
    if (typeof value === "string") {
        return "string";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return "number";
    }
    if (typeof value === "boolean") {
        return "boolean";
    }
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) {
            throw new SparseArrayRenderedValueError();
        }
        return value.map((elem) => buildSchema(elem, cycleDetector));
    }
    if (typeof value === "object") {
        if (cycleDetector && cycleDetector.has(value)) {
            throw new CycleInRenderedValueError();
        }
        if (cycleDetector) cycleDetector.add(value);
        try {
            assertPlainObject(value);
            /** @type {Record<string, unknown>} */
            const obj = value;
            const schema = /** @type {Record<string, import('./schema_codec').TypeSchema>} */ ({});
            for (const key of Object.keys(obj).sort()) {
                schema[key] = buildSchema(obj[key], cycleDetector);
            }
            return schema;
        } finally {
            if (cycleDetector) cycleDetector.delete(value);
        }
    }
    throw new UnsupportedRenderedValueError(
        `Unsupported value type: ${typeof value}`,
        value
    );
}

/**
 * Build rendered leaf entries for a value at a given path prefix.
 *
 * @param {unknown} value
 * @param {string} prefix - The descendant path prefix (empty for root).
 * @param {Set<object>} cycleDetector
 * @returns {RenderedLeaf[]}
 */
function buildLeaves(value, prefix, cycleDetector) {
    if (typeof value === "string") {
        return [{ descendantPath: prefix, content: value }];
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return [{ descendantPath: prefix, content: formatPrimitive(value, "number") }];
    }
    if (typeof value === "boolean") {
        return [{ descendantPath: prefix, content: value ? "true" : "false" }];
    }
    if (value === null) {
        return [{ descendantPath: prefix, content: "null" }];
    }
    if (Array.isArray(value)) {
        const leaves = [];
        for (let i = 0; i < value.length; i++) {
            const elemPrefix = prefix ? `${prefix}/${i}` : `${i}`;
            leaves.push(...buildLeaves(value[i], elemPrefix, cycleDetector));
        }
        return leaves;
    }
    if (typeof value === "object") {
        if (cycleDetector && cycleDetector.has(value)) {
            throw new CycleInRenderedValueError();
        }
        if (cycleDetector) cycleDetector.add(value);
        try {
            const leaves = [];
            const obj = /** @type {Record<string, unknown>} */ (value);
            const sorted = Object.keys(obj).sort();
            for (const key of sorted) {
                const childPrefix = prefix
                    ? `${prefix}/${encodeObjectKey(key)}`
                    : encodeObjectKey(key);
                leaves.push(...buildLeaves(obj[key], childPrefix, cycleDetector));
            }
            return leaves;
        } finally {
            if (cycleDetector) cycleDetector.delete(value);
        }
    }
    throw new UnsupportedRenderedValueError(
        `Unsupported value type: ${typeof value}`,
        value
    );
}

/**
 * Assert that a value is a plain object (not class instance, Date, Map, Set,
 * Buffer, etc.).
 *
 * @param {unknown} value
 * @returns {asserts value is Record<string, unknown>}
 * @throws {NonPlainObjectRenderedValueError}
 */
function assertPlainObject(value) {
    if (typeof value !== "object" || value === null) {
        throw new NonPlainObjectRenderedValueError(
            "Value is not an object", value
        );
    }
    if (Array.isArray(value)) {
        throw new NonPlainObjectRenderedValueError(
            "Array is not a plain object", value
        );
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
        const ctor = value.constructor;
        if (ctor !== Object && typeof ctor === "function" && ctor.name !== "Object") {
            throw new NonPlainObjectRenderedValueError(
                `Non-plain object: ${ctor.name}`, value
            );
        }
    }
    if (typeof (/** @type {Record<string, unknown>} */ (value)['then']) === "function") {
        throw new NonPlainObjectRenderedValueError("Promise-like object", value);
    }
}

/**
 * Reconstruct a DB value from a validated schema and a leaf-reading function.
 *
 * @param {import('./schema_codec').TypeSchema} schema - Already validated.
 * @param {(descendantPath: string) => string | Promise<string>} readLeaf - Reads a primitive leaf
 *   file. Throws MissingRenderedLeafError if the path doesn't exist as a file.
 * @param {string} [prefix] - Current descendant path prefix.
 * @returns {Promise<unknown>}
 * @throws {MissingRenderedLeafError|InvalidNumberLeafError|InvalidBooleanLeafError|InvalidNullLeafError}
 */
async function scanExplodedJsonProjection(schema, readLeaf, prefix) {
    const p = prefix || "";
    if (schema === "string") {
        return await readLeaf(p);
    }
    if (schema === "number") {
        const content = await readLeaf(p);
        return parseNumber(content, "", p);
    }
    if (schema === "boolean") {
        const content = await readLeaf(p);
        return parseBoolean(content, "", p);
    }
    if (schema === "null") {
        const content = await readLeaf(p);
        return parseNull(content, "", p);
    }
    if (Array.isArray(schema)) {
        const result = [];
        for (let i = 0; i < schema.length; i++) {
            const childPrefix = p ? `${p}/${i}` : `${i}`;
            result.push(await scanExplodedJsonProjection(/** @type {import('./schema_codec').TypeSchema} */ (schema[i]), readLeaf, childPrefix));
        }
        return result;
    }
    if (typeof schema === "object" && schema !== null) {
        const result = /** @type {Record<string, unknown>} */ ({});
        const schemaObj = /** @type {Record<string, import('./schema_codec').TypeSchema>} */ (schema);
        for (const key of Object.keys(schemaObj)) {
            const encodedKey = encodeObjectKey(key);
            const childPrefix = p ? `${p}/${encodedKey}` : encodedKey;
            const childSchema = schemaObj[key];
            if (childSchema !== undefined) {
                result[key] = await scanExplodedJsonProjection(childSchema, readLeaf, childPrefix);
            }
        }
        return result;
    }
    throw new Error(`Unexpected schema node: ${JSON.stringify(schema)}`);
}

module.exports = {
    projectExplodedJsonValue,
    scanExplodedJsonProjection,
    buildSchema,
    buildLeaves,
};
