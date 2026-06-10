const { MalformedTypeSchemaError, InvalidTypeSchemaNodeError, UnknownTypeSchemaTokenError } = require('./errors');
const TOKENS = new Set(['string', 'number', 'boolean', 'null']);

/** @param {unknown} schema @param {string} schemaPath @returns {void} */
function validateTypeSchema(schema, schemaPath = '') {
    if (typeof schema === 'string') {
        if (!TOKENS.has(schema)) throw new UnknownTypeSchemaTokenError(schemaPath, schema);
        return;
    }
    if (Array.isArray(schema)) {
        for (let index = 0; index < schema.length; index += 1) validateTypeSchema(schema[index], `${schemaPath}/${index}`);
        return;
    }
    if (schema === null || typeof schema !== 'object' || Object.getPrototypeOf(schema) !== Object.prototype) {
        throw new InvalidTypeSchemaNodeError(schemaPath, schema === null ? 'null' : typeof schema);
    }
    for (const [key, child] of Object.entries(schema)) validateTypeSchema(child, `${schemaPath}/${key}`);
}

/** @param {unknown} schema @returns {unknown} */
function canonicalizeSchema(schema) {
    if (typeof schema === 'string') return schema;
    if (Array.isArray(schema)) return schema.map(canonicalizeSchema);
    if (schema === null || typeof schema !== 'object') throw new InvalidTypeSchemaNodeError('', typeof schema);
    return Object.fromEntries(
        Object.entries(schema).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
            .map(([key, child]) => [key, canonicalizeSchema(child)])
    );
}

/** @param {unknown} schema @returns {string} */
function formatTypeSchema(schema) {
    validateTypeSchema(schema);
    return JSON.stringify(canonicalizeSchema(schema), null, 2);
}

/** @param {string} text @returns {unknown} */
function parseTypeSchema(text) {
    let schema;
    try { schema = JSON.parse(text); } catch (error) { throw new MalformedTypeSchemaError(error); }
    validateTypeSchema(schema);
    return schema;
}
module.exports = { validateTypeSchema, formatTypeSchema, parseTypeSchema };
