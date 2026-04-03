/**
 * Node key handling - stores node identities as JSON objects.
 *
 * A concrete node key is: {head: string, args: Array<ConstValue>}
 * This provides clean serialization for any JSON-serializable binding values.
 *
 * Example:
 * - Pattern: "event(e)" with bindings [{id: 5, time: "today"}]
 * - Concrete key: '{"head":"event","args":[{"id":5,"time":"today"}]}'
 *
 * Benefits:
 * - Makes serialization/deserialization straightforward
 * - Works naturally with any JSON-serializable binding values
 * - No mixing of expression syntax with embedded JSON
 */

const { makeArityMismatchError } = require("./errors");
const {
    stringToNodeKeyString,
    nodeNameToString,
    stringToNodeName,
    nodeKeyStringToString,
} = require("./database");

/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').SchemaPattern} SchemaPattern */

/**
 * A node key object for concrete nodes.
 * @typedef {object} NodeKey
 * @property {NodeName} head - The node name/head
 * @property {Array<ConstValue>} args - The arguments (bound values - ConstValue types only)
 */

/**
 * Creates a canonical string representation of a node key for storage.
 * Order of keys of the serialized object matters! This is by design.
 * @param {NodeKey} key
 * @returns {NodeKeyString}
 */
function serializeNodeKey(key) {
    const headStr = nodeNameToString(key.head);
    const serialized = JSON.stringify({ head: headStr, args: key.args });
    return stringToNodeKeyString(serialized);
}

/**
 * Parses a serialized node key back to an object.
 * @param {NodeKeyString} serialized
 * @returns {NodeKey}
 */
function deserializeNodeKey(serialized) {
    const str = nodeKeyStringToString(serialized);
    const parsed = JSON.parse(str);
    return { head: stringToNodeName(parsed.head), args: parsed.args };
}

/**
 * Creates a node key from a pattern string and positional bindings.
 * Pattern like "event(e)" with bindings [{id: 5}] becomes {head: "event", args: [{id: 5}]}
 * Variable names are ignored - only position matters.
 * @param {SchemaPattern} pattern - Pattern string like "event(e)" or "all_events"
 * @param {Array<ConstValue>} bindings - Positional bindings array (ConstValue types only)
 * @returns {NodeKey}
 */
function createNodeKeyFromPattern(pattern, bindings) {
    const { parseExpr } = require("./expr");
    const expr = parseExpr(pattern);
    const head = expr.name;

    if (expr.kind === "atom") {
        if (bindings.length !== 0) {
            throw makeArityMismatchError(head, 0, bindings.length);
        }
        return { head, args: [] };
    }

    // For call expressions, use positional bindings
    // The arity must match the bindings array length
    if (expr.args.length !== bindings.length) {
        throw makeArityMismatchError(head, expr.args.length, bindings.length);
    }

    // Simply use the bindings array as args (variable names are ignored)
    return { head, args: bindings };
}

/**
 * Return a numeric rank for a ConstValue based on its type.
 * Lower rank = earlier in sort order.
 * Rank order: null(0) < boolean(1) < number(2) < string(3) < array(4) < object(5)
 * @param {ConstValue | null} value
 * @returns {number}
 */
function constValueTypeRank(value) {
    if (value === null) return 0;
    if (typeof value === "boolean") return 1;
    if (typeof value === "number") return 2;
    if (typeof value === "string") return 3;
    if (Array.isArray(value)) return 4;
    return 5; // object
}

/**
 * Compare two ConstValues with a stable total order.
 * Type precedence: null < boolean < number < string < array < object.
 * @param {ConstValue | null} a
 * @param {ConstValue | null} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareConstValue(a, b) {
    const rankA = constValueTypeRank(a);
    const rankB = constValueTypeRank(b);
    if (rankA !== rankB) {
        return rankA - rankB;
    }

    if (a === null) {
        // Both are null (rank 0).
        return 0;
    }

    if (typeof a === "boolean" && typeof b === "boolean") {
        // false < true
        if (a === b) return 0;
        return a ? 1 : -1;
    }

    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }

    if (typeof a === "string" && typeof b === "string") {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        const minLen = Math.min(a.length, b.length);
        for (let i = 0; i < minLen; i++) {
            const aVal = a[i];
            const bVal = b[i];
            if (aVal === undefined || bVal === undefined) {
                throw new Error("compareConstValue: unexpected undefined array element");
            }
            const cmp = compareConstValue(aVal, bVal);
            if (cmp !== 0) return cmp;
        }
        return a.length - b.length;
    }

    // Both are objects (non-array, non-null).
    if (a !== null && typeof a === "object" && !Array.isArray(a) &&
        b !== null && typeof b === "object" && !Array.isArray(b)) {
        const sortedEntriesA = Object.entries(a).sort(([k1], [k2]) => k1 < k2 ? -1 : k1 > k2 ? 1 : 0);
        const sortedEntriesB = Object.entries(b).sort(([k1], [k2]) => k1 < k2 ? -1 : k1 > k2 ? 1 : 0);
        const minLen = Math.min(sortedEntriesA.length, sortedEntriesB.length);
        for (let i = 0; i < minLen; i++) {
            const entryA = sortedEntriesA[i];
            const entryB = sortedEntriesB[i];
            if (entryA === undefined || entryB === undefined) {
                throw new Error("compareConstValue: unexpected undefined entry");
            }
            const [kA, vA] = entryA;
            const [kB, vB] = entryB;
            if (kA < kB) return -1;
            if (kA > kB) return 1;
            const cmp = compareConstValue(vA, vB);
            if (cmp !== 0) return cmp;
        }
        return sortedEntriesA.length - sortedEntriesB.length;
    }

    return 0;
}

/**
 * Compare two NodeKey values with a stable total order.
 * Order: compare head lexicographically, then args.length, then each arg.
 * @param {NodeKey} a
 * @param {NodeKey} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareNodeKey(a, b) {
    const headA = nodeNameToString(a.head);
    const headB = nodeNameToString(b.head);
    if (headA < headB) return -1;
    if (headA > headB) return 1;

    if (a.args.length !== b.args.length) {
        return a.args.length - b.args.length;
    }

    for (let i = 0; i < a.args.length; i++) {
        const aArg = a.args[i];
        const bArg = b.args[i];
        if (aArg === undefined || bArg === undefined) {
            throw new Error("compareNodeKey: unexpected undefined arg at index " + String(i));
        }
        const cmp = compareConstValue(aArg, bArg);
        if (cmp !== 0) return cmp;
    }

    return 0;
}

/**
 * Compare two NodeKeyStrings by deserializing them and delegating to compareNodeKey.
 * This is the canonical comparator for sorted revdeps arrays.
 * @param {NodeKeyString} a
 * @param {NodeKeyString} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareNodeKeyStringByNodeKey(a, b) {
    return compareNodeKey(deserializeNodeKey(a), deserializeNodeKey(b));
}

module.exports = {
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKeyFromPattern,
    compareConstValue,
    compareNodeKey,
    compareNodeKeyStringByNodeKey,
};
