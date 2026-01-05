/**
 * Nominal type wrappers for SchemaPattern and NodeKeyString.
 * 
 * These types enforce separation between:
 * - SchemaPattern: schema-world expression strings like "full_event(e)"
 * - NodeKeyString: runtime-world serialized node keys like '{"head":"full_event","args":[...]}'
 * 
 * The wrapper objects prevent accidental interchange and make the codebase more maintainable.
 */

/**
 * SchemaPattern wraps schema expression strings.
 * Used only for schema definition and variable mapping at compile time.
 * @typedef {{ readonly _tag: 'SchemaPattern', readonly text: string }} SchemaPattern
 */

/**
 * NodeKeyString wraps stringified concrete node keys.
 * Used only for storage, freshness tracking, and dependency edges at runtime.
 * @typedef {{ readonly _tag: 'NodeKeyString', readonly key: string }} NodeKeyString
 */

/**
 * Wraps a string as a SchemaPattern.
 * @param {string} text - Schema expression string (e.g., "event(e)", "all_events")
 * @returns {SchemaPattern}
 */
function asSchemaPattern(text) {
    return Object.freeze({ _tag: 'SchemaPattern', text });
}

/**
 * Wraps a string as a NodeKeyString.
 * @param {string} key - Serialized node key (e.g., '{"head":"event","args":[...]}')
 * @returns {NodeKeyString}
 */
function asNodeKeyString(key) {
    return Object.freeze({ _tag: 'NodeKeyString', key });
}

/**
 * Type guard for SchemaPattern.
 * @param {unknown} x
 * @returns {x is SchemaPattern}
 */
function isSchemaPattern(x) {
    return (
        typeof x === 'object' &&
        x !== null &&
        '_tag' in x &&
        x._tag === 'SchemaPattern' &&
        'text' in x &&
        typeof x.text === 'string'
    );
}

/**
 * Type guard for NodeKeyString.
 * @param {unknown} x
 * @returns {x is NodeKeyString}
 */
function isNodeKeyString(x) {
    return (
        typeof x === 'object' &&
        x !== null &&
        '_tag' in x &&
        x._tag === 'NodeKeyString' &&
        'key' in x &&
        typeof x.key === 'string'
    );
}

/**
 * Asserts that a value is a SchemaPattern.
 * @param {unknown} x
 * @returns {asserts x is SchemaPattern}
 * @throws {Error} If x is not a SchemaPattern
 */
function assertSchemaPattern(x) {
    if (!isSchemaPattern(x)) {
        throw new Error('Expected SchemaPattern');
    }
}

/**
 * Asserts that a value is a NodeKeyString.
 * @param {unknown} x
 * @returns {asserts x is NodeKeyString}
 * @throws {Error} If x is not a NodeKeyString
 */
function assertNodeKeyString(x) {
    if (!isNodeKeyString(x)) {
        throw new Error('Expected NodeKeyString');
    }
}

/**
 * Unwraps a SchemaPattern to its underlying string.
 * Use only at boundaries where plain strings are required.
 * @param {SchemaPattern} pattern
 * @returns {string}
 */
function unwrapSchemaPattern(pattern) {
    assertSchemaPattern(pattern);
    return pattern.text;
}

/**
 * Unwraps a NodeKeyString to its underlying string.
 * Use only at boundaries where plain strings are required (e.g., DB operations).
 * @param {NodeKeyString} keyStr
 * @returns {string}
 */
function unwrapNodeKeyString(keyStr) {
    assertNodeKeyString(keyStr);
    return keyStr.key;
}

module.exports = {
    asSchemaPattern,
    asNodeKeyString,
    isSchemaPattern,
    isNodeKeyString,
    assertSchemaPattern,
    assertNodeKeyString,
    unwrapSchemaPattern,
    unwrapNodeKeyString,
};
