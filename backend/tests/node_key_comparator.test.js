/**
 * Unit tests for NodeKey comparator utilities.
 * Tests compareConstValue, compareNodeKey, and compareNodeKeyStringByNodeKey.
 */

const {
    serializeNodeKey,
    compareConstValue,
    compareNodeKey,
    compareNodeKeyStringByNodeKey,
} = require("../src/generators/incremental_graph/node_key");
const { stringToNodeName } = require("../src/generators/incremental_graph/database");

/**
 * Helper: create a NodeKey.
 * @param {string} head
 * @param {Array<unknown>} args
 */
function nodeKey(head, args = []) {
    return { head: stringToNodeName(head), args };
}

/**
 * Helper: create a NodeKeyString from head+args.
 * @param {string} head
 * @param {Array<unknown>} args
 */
function nks(head, args = []) {
    return serializeNodeKey(nodeKey(head, args));
}

// ---------------------------------------------------------------------------
// compareConstValue - basic type ordering
// ---------------------------------------------------------------------------
describe("compareConstValue – type rank ordering", () => {
    test("null < boolean", () => {
        expect(compareConstValue(null, false)).toBeLessThan(0);
        expect(compareConstValue(null, true)).toBeLessThan(0);
    });

    test("null < number", () => {
        expect(compareConstValue(null, 0)).toBeLessThan(0);
    });

    test("null < string", () => {
        expect(compareConstValue(null, "")).toBeLessThan(0);
    });

    test("null < array", () => {
        expect(compareConstValue(null, [])).toBeLessThan(0);
    });

    test("null < object", () => {
        expect(compareConstValue(null, {})).toBeLessThan(0);
    });

    test("boolean < number", () => {
        expect(compareConstValue(true, 0)).toBeLessThan(0);
    });

    test("boolean < string", () => {
        expect(compareConstValue(false, "")).toBeLessThan(0);
    });

    test("number < string", () => {
        expect(compareConstValue(42, "hello")).toBeLessThan(0);
    });

    test("string < array", () => {
        expect(compareConstValue("z", [])).toBeLessThan(0);
    });

    test("array < object", () => {
        expect(compareConstValue([], {})).toBeLessThan(0);
    });
});

// ---------------------------------------------------------------------------
// compareConstValue – same-type ordering
// ---------------------------------------------------------------------------
describe("compareConstValue – same-type ordering", () => {
    test("null == null", () => {
        expect(compareConstValue(null, null)).toBe(0);
    });

    test("false < true", () => {
        expect(compareConstValue(false, true)).toBeLessThan(0);
        expect(compareConstValue(true, false)).toBeGreaterThan(0);
    });

    test("boolean equality", () => {
        expect(compareConstValue(false, false)).toBe(0);
        expect(compareConstValue(true, true)).toBe(0);
    });

    test("numbers: numeric order", () => {
        expect(compareConstValue(1, 2)).toBeLessThan(0);
        expect(compareConstValue(2, 1)).toBeGreaterThan(0);
        expect(compareConstValue(-5, 3)).toBeLessThan(0);
        expect(compareConstValue(3.14, 3.14)).toBe(0);
    });

    test("strings: lexicographic order", () => {
        expect(compareConstValue("a", "b")).toBeLessThan(0);
        expect(compareConstValue("b", "a")).toBeGreaterThan(0);
        expect(compareConstValue("abc", "abd")).toBeLessThan(0);
        expect(compareConstValue("", "a")).toBeLessThan(0);
        expect(compareConstValue("hello", "hello")).toBe(0);
    });

    test("arrays: lexicographic element-by-element", () => {
        expect(compareConstValue([1, 2], [1, 3])).toBeLessThan(0);
        expect(compareConstValue([1, 3], [1, 2])).toBeGreaterThan(0);
        expect(compareConstValue([1], [1, 2])).toBeLessThan(0); // prefix-equal, shorter first
        expect(compareConstValue([1, 2], [1])).toBeGreaterThan(0);
        expect(compareConstValue([], [])).toBe(0);
        expect(compareConstValue([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    test("arrays: nested type comparison", () => {
        expect(compareConstValue([null, 1], [false, 1])).toBeLessThan(0); // null < boolean
        expect(compareConstValue(["a"], [1])).toBeGreaterThan(0); // string > number
    });

    test("objects: compare sorted keys then values", () => {
        expect(compareConstValue({ a: 1 }, { a: 2 })).toBeLessThan(0);
        expect(compareConstValue({ a: 2 }, { a: 1 })).toBeGreaterThan(0);
        expect(compareConstValue({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(0);
    });

    test("objects: key-order insensitive (same content = equal)", () => {
        // Objects with same keys/values but different insertion order
        const a = {};
        a["z"] = 1;
        a["a"] = 2;
        const b = {};
        b["a"] = 2;
        b["z"] = 1;
        expect(compareConstValue(a, b)).toBe(0);
    });

    test("objects: compare sorted key lists lexicographically", () => {
        // { a: 1 } vs { b: 1 }: "a" < "b"
        expect(compareConstValue({ a: 1 }, { b: 1 })).toBeLessThan(0);
        expect(compareConstValue({ b: 1 }, { a: 1 })).toBeGreaterThan(0);
    });

    test("objects: different number of keys", () => {
        expect(compareConstValue({ a: 1 }, { a: 1, b: 2 })).toBeLessThan(0);
        expect(compareConstValue({ a: 1, b: 2 }, { a: 1 })).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// compareConstValue – mathematical properties
// ---------------------------------------------------------------------------
describe("compareConstValue – mathematical properties", () => {
    const samples = [
        null,
        false,
        true,
        -1,
        0,
        42,
        3.14,
        "",
        "a",
        "z",
        [],
        [1, 2],
        [1, 3],
        {},
        { a: 1 },
        { a: 1, b: 2 },
        { b: 0 },
    ];

    test("antisymmetry: sign(compare(a,b)) === -sign(compare(b,a))", () => {
        for (const a of samples) {
            for (const b of samples) {
                const ab = compareConstValue(a, b);
                const ba = compareConstValue(b, a);
                const signAB = ab < 0 ? -1 : ab > 0 ? 1 : 0;
                const signBA = ba < 0 ? -1 : ba > 0 ? 1 : 0;
                expect(signAB + signBA).toBe(0);
            }
        }
    });

    test("equality: compare(a,a) === 0 for all samples", () => {
        for (const a of samples) {
            expect(compareConstValue(a, a)).toBe(0);
        }
    });

    test("transitivity on representative triples", () => {
        // If a < b and b < c then a < c
        const triples = [
            [null, false, 0],
            [null, 0, "hello"],
            [false, true, 1],
            [1, 2, 3],
            ["a", "b", "c"],
            [[], [1], [1, 2]],
        ];
        for (const [a, b, c] of triples) {
            const ab = compareConstValue(a, b);
            const bc = compareConstValue(b, c);
            const ac = compareConstValue(a, c);
            expect(ab).toBeLessThan(0);
            expect(bc).toBeLessThan(0);
            expect(ac).toBeLessThan(0);
        }
    });

    test("totality: every pair is ordered (no undefined/NaN results)", () => {
        for (const a of samples) {
            for (const b of samples) {
                const result = compareConstValue(a, b);
                expect(typeof result).toBe("number");
                expect(Number.isNaN(result)).toBe(false);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// compareNodeKey
// ---------------------------------------------------------------------------
describe("compareNodeKey", () => {
    test("compare by head lexicographically", () => {
        expect(compareNodeKey(nodeKey("a"), nodeKey("b"))).toBeLessThan(0);
        expect(compareNodeKey(nodeKey("b"), nodeKey("a"))).toBeGreaterThan(0);
        expect(compareNodeKey(nodeKey("a"), nodeKey("a"))).toBe(0);
    });

    test("same head: compare by args.length", () => {
        expect(compareNodeKey(nodeKey("f", []), nodeKey("f", [1]))).toBeLessThan(0);
        expect(compareNodeKey(nodeKey("f", [1]), nodeKey("f", []))).toBeGreaterThan(0);
    });

    test("same head and arity: compare args element-by-element", () => {
        expect(compareNodeKey(nodeKey("f", [1, 2]), nodeKey("f", [1, 3]))).toBeLessThan(0);
        expect(compareNodeKey(nodeKey("f", [1, 3]), nodeKey("f", [1, 2]))).toBeGreaterThan(0);
    });

    test("equal keys compare as 0", () => {
        expect(compareNodeKey(nodeKey("event", [42, "hello"]), nodeKey("event", [42, "hello"]))).toBe(0);
    });

    test("mixed arg types: type precedence applies", () => {
        // null < boolean for first arg
        expect(compareNodeKey(nodeKey("f", [null]), nodeKey("f", [false]))).toBeLessThan(0);
    });

    test("antisymmetry", () => {
        const pairs = [
            [nodeKey("a"), nodeKey("b")],
            [nodeKey("f", [1]), nodeKey("f", [2])],
            [nodeKey("f", []), nodeKey("f", [1])],
        ];
        for (const [a, b] of pairs) {
            const ab = compareNodeKey(a, b);
            const ba = compareNodeKey(b, a);
            const sAB = ab < 0 ? -1 : ab > 0 ? 1 : 0;
            const sBA = ba < 0 ? -1 : ba > 0 ? 1 : 0;
            expect(sAB).toBe(-sBA);
        }
    });
});

// ---------------------------------------------------------------------------
// compareNodeKeyStringByNodeKey
// ---------------------------------------------------------------------------
describe("compareNodeKeyStringByNodeKey", () => {
    test("orders node key strings consistently with compareNodeKey", () => {
        const a = nks("a");
        const b = nks("b");
        expect(compareNodeKeyStringByNodeKey(a, b)).toBeLessThan(0);
        expect(compareNodeKeyStringByNodeKey(b, a)).toBeGreaterThan(0);
    });

    test("equal keys compare as 0", () => {
        const a = nks("event", [42]);
        expect(compareNodeKeyStringByNodeKey(a, a)).toBe(0);
    });

    test("can sort an array of NodeKeyStrings deterministically", () => {
        const keys = [nks("z"), nks("a"), nks("m")];
        const sorted = [...keys].sort(compareNodeKeyStringByNodeKey);
        expect(sorted).toEqual([nks("a"), nks("m"), nks("z")]);
    });

    test("sort is stable across repeated calls", () => {
        const keys = [nks("c"), nks("a"), nks("b")];
        const sorted1 = [...keys].sort(compareNodeKeyStringByNodeKey);
        const sorted2 = [...keys].sort(compareNodeKeyStringByNodeKey);
        expect(sorted1).toEqual(sorted2);
    });

    test("nodes with numeric args are sorted numerically", () => {
        const a = nks("f", [1]);
        const b = nks("f", [2]);
        const c = nks("f", [10]);
        const sorted = [c, a, b].sort(compareNodeKeyStringByNodeKey);
        expect(sorted).toEqual([a, b, c]);
    });

    test("nodes with mixed arg types are sorted by type rank", () => {
        const withNull = nks("f", [null]);
        const withBool = nks("f", [false]);
        const withNum = nks("f", [1]);
        const withStr = nks("f", ["hello"]);
        const sorted = [withStr, withNum, withBool, withNull].sort(compareNodeKeyStringByNodeKey);
        expect(sorted).toEqual([withNull, withBool, withNum, withStr]);
    });
});
