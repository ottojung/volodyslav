/**
 * Canonical JSON semantic-value rules owned by IncrementalGraph.
 */

/** @typedef {import('./recursive_types').ComputedValue} ComputedValue */
/** @typedef {import('./recursive_types').ConstValue} ConstValue */
/** @typedef {import('./database/types').VolodyslavNodeValue} VolodyslavNodeValue */

/**
 * Compare canonical JSON semantic values using the normative graph equality.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function isEqual(left, right) {
    if (left === null || right === null) return left === right;
    if (typeof left !== "object" || typeof right !== "object") return left === right;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(left, index)
                || !Object.prototype.hasOwnProperty.call(right, index)
                || !isEqual(Reflect.get(left, index), Reflect.get(right, index))) {
                return false;
            }
        }
        return true;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index]
        && isEqual(Reflect.get(left, key), Reflect.get(right, key)));
}

/**
 * Require the original value to be data-only JSON structure. JSON serialization
 * runs before this check; callers persist only the parsed return value.
 *
 * @param {unknown} value
 * @param {boolean} allowNull
 * @param {Error} invalidValueError
 * @returns {void}
 */
function assertJsonDomainShape(value, allowNull, invalidValueError) {
    if (value === null) {
        if (allowNull) return;
        throw invalidValueError;
    }
    if (typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
        if (Number.isFinite(value)) return;
        throw invalidValueError;
    }
    if (typeof value !== "object") throw invalidValueError;
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(value, index)) throw invalidValueError;
            assertJsonDomainShape(Reflect.get(value, index), allowNull, invalidValueError);
        }
        return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidValueError;
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
        if (typeof key !== "string") throw invalidValueError;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
            throw invalidValueError;
        }
        assertJsonDomainShape(descriptor.value, allowNull, invalidValueError);
    }
}

/**
 * Canonicalize a semantic value through the one production JSON boundary.
 *
 * @overload
 * @param {VolodyslavNodeValue} value
 * @param {true} allowNull
 * @param {Error} invalidValueError
 * @returns {VolodyslavNodeValue}
 */
/**
 * @overload
 * @param {unknown} value
 * @param {false} allowNull
 * @param {Error} invalidValueError
 * @returns {ConstValue}
 */
/**
 * @overload
 * @param {unknown} value
 * @param {true} allowNull
 * @param {Error} invalidValueError
 * @returns {ComputedValue}
 */
/**
 * @param {unknown} value
 * @param {boolean} allowNull
 * @param {Error} invalidValueError
 * @returns {ComputedValue}
 */
function canonicalizeJsonValue(value, allowNull, invalidValueError) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    } catch {
        throw invalidValueError;
    }
    if (serialized === undefined) throw invalidValueError;

    const canonical = JSON.parse(serialized);
    assertJsonDomainShape(value, allowNull, invalidValueError);
    assertJsonDomainShape(canonical, allowNull, invalidValueError);
    if (!isEqual(value, canonical)) throw invalidValueError;
    return canonical;
}

module.exports = { canonicalizeJsonValue, isEqual };
