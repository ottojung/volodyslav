const { MalformedTypeSchemaError, InvalidTypeSchemaNodeError, UnknownTypeSchemaTokenError, DuplicateMemberNameError } = require('./errors');
const TOKENS = new Set(['string', 'number', 'boolean', 'null']);

/** @param {string} text @returns {void} */
function detectDuplicateKeys(text) {
    let pos = 0;
    const len = text.length;

    function ch() { return text.charAt(pos); }

    function skipWs() {
        while (pos < len && (ch() === ' ' || ch() === '\t' || ch() === '\n' || ch() === '\r')) pos++;
    }

    function skipStr() {
        pos++;
        while (pos < len) {
            if (ch() === '\\') { pos += 2; continue; }
            if (ch() === '"') break;
            pos++;
        }
        pos++;
    }

    function skipNum() {
        if (pos < len && ch() === '-') pos++;
        while (pos < len && ch() >= '0' && ch() <= '9') pos++;
        if (pos < len && ch() === '.') { pos++; while (pos < len && ch() >= '0' && ch() <= '9') pos++; }
        if (pos < len && (ch() === 'e' || ch() === 'E')) {
            pos++;
            if (pos < len && (ch() === '+' || ch() === '-')) pos++;
            while (pos < len && ch() >= '0' && ch() <= '9') pos++;
        }
    }

    function skipVal() {
        skipWs();
        if (pos >= len) return;
        const c = ch();
        if (c === '"') { skipStr(); return; }
        if (c === '{') { parseObj(); return; }
        if (c === '[') { parseArr(); return; }
        if (c === '-' || (c >= '0' && c <= '9')) { skipNum(); return; }
        if (text.startsWith('true', pos)) { pos += 4; return; }
        if (text.startsWith('false', pos)) { pos += 5; return; }
        if (text.startsWith('null', pos)) { pos += 4; return; }
    }

    function parseArr() {
        pos++;
        while (pos < len) {
            skipWs();
            if (ch() === ']') { pos++; return; }
            skipVal();
            skipWs();
            if (pos < len && ch() === ',') pos++;
        }
    }

    function parseObj() {
        pos++;
        const seen = new Set();
        while (pos < len) {
            skipWs();
            if (ch() === '}') { pos++; return; }
            const start = pos;
            skipStr();
            const key = JSON.parse(text.slice(start, pos));
            if (seen.has(key)) throw new DuplicateMemberNameError(String(key));
            seen.add(key);
            skipWs();
            if (pos < len && ch() === ':') pos++;
            skipVal();
            skipWs();
            if (pos < len && ch() === ',') pos++;
        }
    }

    skipWs();
    if (pos < len) {
        if (ch() === '{') parseObj();
        else if (ch() === '[') parseArr();
    }
}

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
    detectDuplicateKeys(text);
    validateTypeSchema(schema);
    return schema;
}
module.exports = { validateTypeSchema, formatTypeSchema, parseTypeSchema };
