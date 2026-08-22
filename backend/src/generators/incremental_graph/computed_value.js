/**
 * Runtime rules for values persisted by IncrementalGraph.
 */

/**
 * Validate one recursively JSON-round-trippable ComputedValue.
 *
 * Arrays must be dense. Records must be plain objects because prototypes such
 * as Date change semantic type under JSON serialization. Cycles are rejected
 * because JSON cannot persist them.
 *
 * @param {unknown} value
 * @param {Error} invalidValueError
 * @returns {void}
 */
function assertComputedValue(value, invalidValueError) {
    const ancestors = new WeakSet();

    /**
     * @param {unknown} nestedValue
     * @returns {void}
     */
    function visit(nestedValue) {
        if (nestedValue === null || typeof nestedValue === "string" || typeof nestedValue === "boolean") {
            return;
        }
        if (typeof nestedValue === "number") {
            if (Number.isFinite(nestedValue)) return;
            throw invalidValueError;
        }
        if (typeof nestedValue !== "object") {
            throw invalidValueError;
        }
        if (ancestors.has(nestedValue)) {
            throw invalidValueError;
        }
        ancestors.add(nestedValue);
        if (Array.isArray(nestedValue)) {
            for (let index = 0; index < nestedValue.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(nestedValue, index)) {
                    throw invalidValueError;
                }
                visit(nestedValue[index]);
            }
        } else {
            const prototype = Object.getPrototypeOf(nestedValue);
            if (prototype !== Object.prototype && prototype !== null) {
                throw invalidValueError;
            }
            for (const key of Object.keys(nestedValue)) {
                visit(Reflect.get(nestedValue, key));
            }
        }
        ancestors.delete(nestedValue);
    }

    visit(value);
}

/**
 * Compare validated semantic values using the normative graph equality.
 * Record keys use ECMAScript `Object.keys` order, including its numeric-index
 * ordering, and numbers use JavaScript equality so both zero signs are equal.
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
        return left.every((value, index) => isEqual(value, Reflect.get(right, index)));
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index]
        && isEqual(Reflect.get(left, key), Reflect.get(right, key)));
}

module.exports = { assertComputedValue, isEqual };
