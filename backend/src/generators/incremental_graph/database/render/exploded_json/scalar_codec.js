const { InvalidNumberLeafError, InvalidBooleanLeafError, InvalidNullLeafError } = require('./errors');
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** @param {string | number | boolean | null} value @returns {string} */
function renderScalar(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Object.is(value, -0) ? '0' : JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return 'null';
}

/** @param {string} token @param {string} content @param {string} descendantPath @returns {string | number | boolean | null} */
function scanScalar(token, content, descendantPath) {
    if (token === 'string') return content;
    if (token === 'number') {
        const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
        if (!JSON_NUMBER_PATTERN.test(trimmed)) throw new InvalidNumberLeafError(descendantPath, content);
        const value = Number(trimmed);
        if (!Number.isFinite(value)) throw new InvalidNumberLeafError(descendantPath, content);
        return Object.is(value, -0) ? 0 : value;
    }
    if (token === 'boolean') {
        if (content === 'true' || content === 'true\n') return true;
        if (content === 'false' || content === 'false\n') return false;
        throw new InvalidBooleanLeafError(descendantPath, content);
    }
    if (content === 'null' || content === 'null\n') return null;
    throw new InvalidNullLeafError(descendantPath, content);
}
module.exports = { renderScalar, scanScalar };
