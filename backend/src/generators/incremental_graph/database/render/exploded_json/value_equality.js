/**
 * @file JSON structural equality for DB value comparison.
 *
 * Used during filesystem-to-DB reconciliation to avoid semantic rewrites
 * caused by object insertion order differences.
 */

/**
 * Compare two values for JSON structural equality.
 *
 * Rules:
 *   - Primitive values compare by JSON semantics.
 *   - Numbers treat -0 and 0 as equal.
 *   - Arrays require same length and pairwise equality in order.
 *   - Objects require same key set and recursive equality regardless of
 *     insertion order.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonStructuralEquals(a, b) {
    if (typeof a !== typeof b) {
        return false;
    }
    if (typeof a === "number") {
        if (Number.isFinite(a) && Number.isFinite(b)) {
            if (a === 0 && b === 0) return true;
            return a === b;
        }
        return Object.is(a, b);
    }
    if (a === null) {
        return b === null;
    }
    if (typeof a === "string" || typeof a === "boolean") {
        return a === b;
    }
    if (Array.isArray(a)) {
        if (!Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!jsonStructuralEquals(a[i], b[i])) return false;
        }
        return true;
    }
    if (typeof a === "object" && a !== null) {
        if (Array.isArray(b)) return false;
        if (typeof b !== "object" || b === null) return false;
        const objA = /** @type {Record<string, unknown>} */ (a);
        const objB = /** @type {Record<string, unknown>} */ (b);
        const keysA = Object.keys(objA);
        const keysB = Object.keys(objB);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!(key in objB)) return false;
            if (!jsonStructuralEquals(objA[key], objB[key])) return false;
        }
        return true;
    }
    return Object.is(a, b);
}

module.exports = {
    jsonStructuralEquals,
};
