/**
 * @file Tests for the exploded JSON value codec.
 *
 * Covers the pure codec layer: value projection, schema codec, scalar codec,
 * path codec, virtual file keys, and structural equality.
 */

const {
    projectExplodedJsonValue,
    scanExplodedJsonProjection,
    parseSchema,
    formatSchema,
    validateSchema,
    schemaHasPrimitiveLeaves,
    formatPrimitive,
    parseNumber,
    parseBoolean,
    parseNull,
    encodeObjectKey,
    decodeObjectKey,
    validateArrayIndex,
    kindtreeVirtualKey,
    renderedVirtualKey,
    parseVirtualKey,
    virtualKeyToPhysicalPath,
    flattenProjection,
    jsonStructuralEquals,
} = require('../src/generators/incremental_graph/database/render/exploded_json');

const {
    UnsupportedRenderedValueError,
    CycleInRenderedValueError,
    SparseArrayRenderedValueError,
    NonPlainObjectRenderedValueError,
    InvalidNumberLeafError,
    InvalidBooleanLeafError,
    InvalidNullLeafError,
    MalformedTypeSchemaError,
    InvalidTypeSchemaNodeError,
    UnknownTypeSchemaTokenError,
    DuplicateSchemaKeyError,
    MissingRenderedLeafError,
    DuplicateDecodedPathError,
} = require('../src/generators/incremental_graph/database/render/exploded_json/errors');

// -------------------------------------------------------------------------
// 1. String scalar
// -------------------------------------------------------------------------
describe('string scalar', () => {
    test('renders plain "hello" with schema "string"', () => {
        const p = projectExplodedJsonValue("hello");
        expect(p.schema).toBe("string");
        expect(p.schemaText).toBe('"string"');
        expect(p.leaves).toEqual([{ descendantPath: "", content: "hello" }]);
    });

    test('empty string creates zero-byte content', () => {
        const p = projectExplodedJsonValue("");
        expect(p.leaves).toEqual([{ descendantPath: "", content: "" }]);
    });

    test('preserves leading and trailing whitespace', () => {
        const p = projectExplodedJsonValue("  hello  ");
        expect(p.leaves[0].content).toBe("  hello  ");
    });

    test('preserves multiline string including final newline', () => {
        const p = projectExplodedJsonValue("line1\nline2\n");
        expect(p.leaves[0].content).toBe("line1\nline2\n");
    });

    test.each(["5", "null", "true", "false", '{"x":1}'])(
        'strings like "%s" remain strings according to schema, not parsed',
        (s) => {
            const p = projectExplodedJsonValue(s);
            expect(p.schema).toBe("string");
            expect(p.leaves[0].content).toBe(s);
        }
    );
});

// -------------------------------------------------------------------------
// 2. Number scalar
// -------------------------------------------------------------------------
describe('number scalar', () => {
    test('integer', () => {
        const p = projectExplodedJsonValue(5);
        expect(p.schema).toBe("number");
        expect(p.leaves[0].content).toBe("5");
    });

    test('decimal', () => {
        const p = projectExplodedJsonValue(1.5);
        expect(p.leaves[0].content).toBe("1.5");
    });

    test('zero', () => {
        const p = projectExplodedJsonValue(0);
        expect(p.leaves[0].content).toBe("0");
    });

    test('negative', () => {
        const p = projectExplodedJsonValue(-12);
        expect(p.leaves[0].content).toBe("-12");
    });

    test('negative zero canonicalizes to 0', () => {
        const p = projectExplodedJsonValue(-0);
        expect(p.leaves[0].content).toBe("0");
    });

    test('exponent notation', () => {
        const p = projectExplodedJsonValue(1e21);
        expect(p.leaves[0].content).toBe("1e+21");
    });
});

// -------------------------------------------------------------------------
// 3. Boolean scalar
// -------------------------------------------------------------------------
describe('boolean scalar', () => {
    test('root true', () => {
        const p = projectExplodedJsonValue(true);
        expect(p.schema).toBe("boolean");
        expect(p.leaves).toEqual([{ descendantPath: "", content: "true" }]);
    });

    test('root false', () => {
        const p = projectExplodedJsonValue(false);
        expect(p.schema).toBe("boolean");
        expect(p.leaves).toEqual([{ descendantPath: "", content: "false" }]);
    });

    test('boolean object properties', () => {
        const p = projectExplodedJsonValue({ a: true, b: false });
        expect(p.schema).toEqual({ a: "boolean", b: "boolean" });
        expect(p.leaves).toHaveLength(2);
    });

    test('boolean array elements', () => {
        const p = projectExplodedJsonValue([true, false]);
        expect(p.schema).toEqual(["boolean", "boolean"]);
        expect(p.leaves).toHaveLength(2);
        expect(p.leaves[0].descendantPath).toBe("0");
        expect(p.leaves[1].descendantPath).toBe("1");
    });
});

// -------------------------------------------------------------------------
// 4. Null
// -------------------------------------------------------------------------
describe('null', () => {
    test('renders exact null with schema "null"', () => {
        const p = projectExplodedJsonValue(null);
        expect(p.schema).toBe("null");
        expect(p.leaves).toEqual([{ descendantPath: "", content: "null" }]);
    });
});

// -------------------------------------------------------------------------
// 5. Object rendering
// -------------------------------------------------------------------------
describe('object rendering', () => {
    test('flat object', () => {
        const p = projectExplodedJsonValue({ x: 1, y: "hi" });
        expect(p.schema).toEqual({ x: "number", y: "string" });
        expect(p.leaves).toHaveLength(2);
    });

    test('nested object', () => {
        const value = { a: { b: { c: "deep" } } };
        const p = projectExplodedJsonValue(value);
        expect(p.schema).toEqual({ a: { b: { c: "string" } } });
        expect(p.leaves).toHaveLength(1);
        expect(p.leaves[0].descendantPath).toBe("a/b/c");
        expect(p.leaves[0].content).toBe("deep");
    });

    test('deeply nested object/array structure', () => {
        const value = { items: [{ name: "a" }, { name: "b" }] };
        const p = projectExplodedJsonValue(value);
        expect(p.leaves).toHaveLength(2);
        expect(p.leaves[0].content).toBe("a");
        expect(p.leaves[1].content).toBe("b");
    });

    test('keys "0" and "1" remain object properties', () => {
        const p = projectExplodedJsonValue({ "0": "a", "1": "b" });
        expect(p.leaves[0].descendantPath).toBe("0");
        expect(p.leaves[1].descendantPath).toBe("1");
        expect(p.schema).toEqual({ "0": "string", "1": "string" });
    });
});

// -------------------------------------------------------------------------
// 6. Empty and primitive-free compounds
// -------------------------------------------------------------------------
describe('empty and primitive-free compounds', () => {
    test('root {} has schema and no rendered leaves', () => {
        const p = projectExplodedJsonValue({});
        expect(p.schema).toEqual({});
        expect(p.schemaText).toBe('{}');
        expect(p.leaves).toHaveLength(0);
    });

    test('root [] has schema and no rendered leaves', () => {
        const p = projectExplodedJsonValue([]);
        expect(p.schema).toEqual([]);
        expect(p.schemaText).toBe('[]');
        expect(p.leaves).toHaveLength(0);
    });

    test('empty object property has no rendered leaves', () => {
        const p = projectExplodedJsonValue({ x: {} });
        expect(p.leaves).toHaveLength(0);
    });

    test('empty array property has no rendered leaves', () => {
        const p = projectExplodedJsonValue({ x: [] });
        expect(p.leaves).toHaveLength(0);
    });

    test('array element {} has no rendered leaves', () => {
        const p = projectExplodedJsonValue([{}]);
        expect(p.leaves).toHaveLength(0);
    });

    test('array element [] has no rendered leaves', () => {
        const p = projectExplodedJsonValue([[]]);
        expect(p.leaves).toHaveLength(0);
    });

    test('object containing only empty compounds has schema but no leaves', () => {
        const p = projectExplodedJsonValue({ a: {}, b: [] });
        expect(p.leaves).toHaveLength(0);
        expect(p.schema).toEqual({ a: {}, b: [] });
    });

    test('array containing only empty compounds has schema but no leaves', () => {
        const p = projectExplodedJsonValue([{}, []]);
        expect(p.leaves).toHaveLength(0);
    });

    test('deeply nested empty compounds have schema but no leaves', () => {
        const p = projectExplodedJsonValue({ a: { b: [[], {}] } });
        expect(p.leaves).toHaveLength(0);
    });

    test('compound with both primitives and empty children renders only primitives', () => {
        const p = projectExplodedJsonValue({ x: 1, y: {}, z: [] });
        expect(p.leaves).toHaveLength(1);
        expect(p.leaves[0].descendantPath).toBe("x");
    });
});

// -------------------------------------------------------------------------
// 7. Dangerous object keys
// -------------------------------------------------------------------------
describe('dangerous object keys', () => {
    const cases = [
        ["", "%00"],
        ["%00", "%2500"],
        [".", "%2E"],
        ["%2E", "%252E"],
        ["..", "%2E%2E"],
        ["a/b", "a%2Fb"],
        ["50%off", "50%25off"],
        ["a!b", "a%21b"],
        ["%2F", "%252F"],
        ["0", "0"],
        ["items", "items"],
        ["rendered", "rendered"],
        ["kindtree", "kindtree"],
    ];

    test.each(cases)('key %p encodes to %p', (key, expected) => {
        expect(encodeObjectKey(key)).toBe(expected);
    });

    test.each(cases)('key %p round-trips through encode/decode', (key) => {
        expect(decodeObjectKey(encodeObjectKey(key))).toBe(key);
    });

    test('keys named "items", "rendered", "kindtree" have no reserved behavior', () => {
        const value = {
            items: 1,
            rendered: 2,
            kindtree: 3,
        };
        const p = projectExplodedJsonValue(value);
        expect(p.leaves).toHaveLength(3);
        const paths = p.leaves.map(l => l.descendantPath).sort();
        expect(paths).toEqual(["items", "kindtree", "rendered"]);
    });
});

// -------------------------------------------------------------------------
// 8. Array indices
// -------------------------------------------------------------------------
describe('array indices', () => {
    test('arrays with index 10 scan correctly independently of lexical order', () => {
        const arr = Array.from({ length: 11 }, (_, i) => i);
        const p = projectExplodedJsonValue(arr);
        expect(p.leaves).toHaveLength(11);
        // The leaf for index 10 should have descendantPath "10"
        const leaf10 = p.leaves.find(l => l.descendantPath === "10");
        expect(leaf10).toBeDefined();
        expect(leaf10.content).toBe("10");
    });

    test('array indices use unpadded decimal names', () => {
        const p = projectExplodedJsonValue(["a", "b", "c"]);
        expect(p.leaves[0].descendantPath).toBe("0");
        expect(p.leaves[1].descendantPath).toBe("1");
        expect(p.leaves[2].descendantPath).toBe("2");
    });
});

// -------------------------------------------------------------------------
// 9. Canonical ordering
// -------------------------------------------------------------------------
describe('canonical ordering', () => {
    test('opposite object insertion orders produce byte-identical canonical output', () => {
        const a = { z: 1, y: 2, x: 3 };
        const b = { x: 3, y: 2, z: 1 };
        const pa = projectExplodedJsonValue(a);
        const pb = projectExplodedJsonValue(b);
        expect(pa.schemaText).toBe(pb.schemaText);
        expect(pa.leaves.map(l => l.descendantPath)).toEqual(
            pb.leaves.map(l => l.descendantPath)
        );
    });
});

// -------------------------------------------------------------------------
// 10. Unsupported source values
// -------------------------------------------------------------------------
describe('unsupported source values', () => {
    test('undefined root', () => {
        expect(() => projectExplodedJsonValue(undefined))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('NaN', () => {
        expect(() => projectExplodedJsonValue(NaN))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('Infinity', () => {
        expect(() => projectExplodedJsonValue(Infinity))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('-Infinity', () => {
        expect(() => projectExplodedJsonValue(-Infinity))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('bigint', () => {
        expect(() => projectExplodedJsonValue(BigInt(42)))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('function', () => {
        expect(() => projectExplodedJsonValue(() => {}))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('symbol', () => {
        expect(() => projectExplodedJsonValue(Symbol("x")))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('sparse array', () => {
        const arr = [];
        arr[1] = "a";
        expect(() => projectExplodedJsonValue(arr))
            .toThrow(SparseArrayRenderedValueError);
    });

    test('cyclic object', () => {
        const obj = {};
        obj.self = obj;
        expect(() => projectExplodedJsonValue(obj))
            .toThrow(CycleInRenderedValueError);
    });

    test('class instance', () => {
        class Foo {}
        expect(() => projectExplodedJsonValue(new Foo()))
            .toThrow(NonPlainObjectRenderedValueError);
    });

    test('Date', () => {
        expect(() => projectExplodedJsonValue(new Date()))
            .toThrow(NonPlainObjectRenderedValueError);
    });

    test('Buffer', () => {
        expect(() => projectExplodedJsonValue(Buffer.from("abc")))
            .toThrow(NonPlainObjectRenderedValueError);
    });

    test('Map', () => {
        expect(() => projectExplodedJsonValue(new Map()))
            .toThrow(NonPlainObjectRenderedValueError);
    });

    test('Set', () => {
        expect(() => projectExplodedJsonValue(new Set()))
            .toThrow(NonPlainObjectRenderedValueError);
    });

    test('undefined object property', () => {
        expect(() => projectExplodedJsonValue({ x: undefined }))
            .toThrow(UnsupportedRenderedValueError);
    });

    test('undefined array element', () => {
        expect(() => projectExplodedJsonValue([undefined]))
            .toThrow(UnsupportedRenderedValueError);
    });
});

// -------------------------------------------------------------------------
// 11. Schema parsing and validation
// -------------------------------------------------------------------------
describe('schema parsing and validation', () => {
    test('parses valid schema JSON', () => {
        const schema = parseSchema('{"a":"string","b":"number"}');
        expect(schema).toEqual({ a: "string", b: "number" });
    });

    test('rejects malformed JSON', () => {
        expect(() => parseSchema('{bad'))
            .toThrow(MalformedTypeSchemaError);
    });

    test('rejects unknown token "undefined"', () => {
        expect(() => parseSchema('"undefined"'))
            .toThrow(UnknownTypeSchemaTokenError);
    });

    test('rejects "object" token', () => {
        expect(() => parseSchema('"object"'))
            .toThrow(UnknownTypeSchemaTokenError);
    });

    test('rejects "array" token', () => {
        expect(() => parseSchema('"array"'))
            .toThrow(UnknownTypeSchemaTokenError);
    });

    test('rejects literal null', () => {
        expect(() => parseSchema('null'))
            .toThrow(InvalidTypeSchemaNodeError);
    });

    test('rejects literal number', () => {
        expect(() => parseSchema('42'))
            .toThrow(InvalidTypeSchemaNodeError);
    });

    test('rejects literal true', () => {
        expect(() => parseSchema('true'))
            .toThrow(InvalidTypeSchemaNodeError);
    });

    test('rejects duplicate schema object keys', () => {
        expect(() => parseSchema('{"a":"string","a":"number"}'))
            .toThrow(DuplicateSchemaKeyError);
    });

    test('schemaHasPrimitiveLeaves returns true for primitives', () => {
        expect(schemaHasPrimitiveLeaves("string")).toBe(true);
        expect(schemaHasPrimitiveLeaves("number")).toBe(true);
        expect(schemaHasPrimitiveLeaves("boolean")).toBe(true);
        expect(schemaHasPrimitiveLeaves("null")).toBe(true);
    });

    test('schemaHasPrimitiveLeaves returns false for empty compounds', () => {
        expect(schemaHasPrimitiveLeaves({})).toBe(false);
        expect(schemaHasPrimitiveLeaves([])).toBe(false);
    });
});

// -------------------------------------------------------------------------
// 12. Schema formatting
// -------------------------------------------------------------------------
describe('schema formatting', () => {
    test('formats simple schema with canonical JSON', () => {
        const text = formatSchema({ a: "string", b: "number" });
        expect(text).toBe('{\n  "a": "string",\n  "b": "number"\n}');
    });

    test('sorts object keys', () => {
        const text = formatSchema({ z: "null", a: "boolean" });
        expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));
    });

    test('has no trailing newline', () => {
        const text = formatSchema({});
        expect(text).toBe('{}');
        expect(text.endsWith('\n')).toBe(false);
    });
});

// -------------------------------------------------------------------------
// 13. Scalar parsing
// -------------------------------------------------------------------------
describe('scalar parsing', () => {
    describe('parseNumber', () => {
        test('parses valid number', () => {
            expect(parseNumber("42")).toBe(42);
        });

        test('rejects non-numeric text', () => {
            expect(() => parseNumber("abc"))
                .toThrow(InvalidNumberLeafError);
        });

        test('rejects trailing garbage', () => {
            expect(() => parseNumber("5x"))
                .toThrow(InvalidNumberLeafError);
        });

        test('rejects NaN', () => {
            expect(() => parseNumber("NaN"))
                .toThrow(InvalidNumberLeafError);
        });

        test('rejects Infinity', () => {
            expect(() => parseNumber("Infinity"))
                .toThrow(InvalidNumberLeafError);
        });
    });

    describe('parseBoolean', () => {
        test('parses true', () => {
            expect(parseBoolean("true")).toBe(true);
        });

        test('parses false', () => {
            expect(parseBoolean("false")).toBe(false);
        });

        test('rejects TRUE', () => {
            expect(() => parseBoolean("TRUE"))
                .toThrow(InvalidBooleanLeafError);
        });

        test('rejects False', () => {
            expect(() => parseBoolean("False"))
                .toThrow(InvalidBooleanLeafError);
        });

        test('rejects "1"', () => {
            expect(() => parseBoolean("1"))
                .toThrow(InvalidBooleanLeafError);
        });

        test('rejects leading space', () => {
            expect(() => parseBoolean(" true"))
                .toThrow(InvalidBooleanLeafError);
        });

        test('rejects trailing space', () => {
            expect(() => parseBoolean("true "))
                .toThrow(InvalidBooleanLeafError);
        });
    });

    describe('parseNull', () => {
        test('parses null', () => {
            expect(parseNull("null")).toBe(null);
        });

        test('rejects NULL', () => {
            expect(() => parseNull("NULL"))
                .toThrow(InvalidNullLeafError);
        });

        test('rejects whitespace', () => {
            expect(() => parseNull(" null"))
                .toThrow(InvalidNullLeafError);
        });
    });
});

// -------------------------------------------------------------------------
// 14. Path codec
// -------------------------------------------------------------------------
describe('path codec', () => {
    test('validateArrayIndex accepts valid indices', () => {
        expect(validateArrayIndex("0")).toBe("0");
        expect(validateArrayIndex("1")).toBe("1");
        expect(validateArrayIndex("10")).toBe("10");
        expect(validateArrayIndex("123456789")).toBe("123456789");
    });

    test('validateArrayIndex rejects padded indices', () => {
        expect(() => validateArrayIndex("00")).toThrow();
        expect(() => validateArrayIndex("01")).toThrow();
    });

    test('validateArrayIndex rejects negative', () => {
        expect(() => validateArrayIndex("-1")).toThrow();
        expect(() => validateArrayIndex("+1")).toThrow();
    });

    test('validateArrayIndex rejects fractional', () => {
        expect(() => validateArrayIndex("1.5")).toThrow();
        expect(() => validateArrayIndex("1.0")).toThrow();
    });

    test('validateArrayIndex rejects non-numeric', () => {
        expect(() => validateArrayIndex("x")).toThrow();
        expect(() => validateArrayIndex("1e1")).toThrow();
    });
});

// -------------------------------------------------------------------------
// 15. Virtual file keys
// -------------------------------------------------------------------------
describe('virtual file keys', () => {
    test('kindtreeVirtualKey produces correct format', () => {
        const vk = kindtreeVirtualKey("r/values/nodeA");
        expect(vk).toBe("r/values/nodeA\x00k\x00");
    });

    test('renderedVirtualKey produces correct format for scalar root', () => {
        const vk = renderedVirtualKey("r/values/nodeA");
        expect(vk).toBe("r/values/nodeA\x00r\x00");
    });

    test('renderedVirtualKey produces correct format for descendant', () => {
        const vk = renderedVirtualKey("r/values/nodeA", "key1");
        expect(vk).toBe("r/values/nodeA\x00r\x00key1");
    });

    test('parseVirtualKey round-trips', () => {
        const vk = "r/values/nodeA\x00r\x00items/0";
        const parsed = parseVirtualKey(vk);
        expect(parsed).toEqual({
            valueRoot: "r/values/nodeA",
            tree: "r",
            descendantPath: "items/0",
        });
    });

    test('virtualKeyToPhysicalPath converts kindtree key', () => {
        const vk = kindtreeVirtualKey("r/values/nodeA");
        const path = virtualKeyToPhysicalPath(vk, "r");
        expect(path).toBe("kindtree/r/r/values/nodeA");
    });

    test('virtualKeyToPhysicalPath converts rendered scalar', () => {
        const vk = renderedVirtualKey("r/values/nodeA");
        const path = virtualKeyToPhysicalPath(vk, "r");
        expect(path).toBe("rendered/r/r/values/nodeA");
    });

    test('virtualKeyToPhysicalPath converts rendered descendant', () => {
        const vk = renderedVirtualKey("r/values/nodeA", "key1");
        const path = virtualKeyToPhysicalPath(vk, "r");
        expect(path).toBe("rendered/r/r/values/nodeA/key1");
    });
});

// -------------------------------------------------------------------------
// 16. Flatten projection
// -------------------------------------------------------------------------
describe('flatten projection', () => {
    test('flattens scalar projection to virtual entries', () => {
        const p = projectExplodedJsonValue("hello");
        const entries = flattenProjection("r/values/nodeA", p);
        expect(entries).toHaveLength(2);
        expect(entries[0].virtualKey).toContain("\x00k\x00");
        expect(entries[0].content).toBe('"string"');
        expect(entries[1].virtualKey).toContain("\x00r\x00");
        expect(entries[1].content).toBe("hello");
    });

    test('flattens empty object projection (schema only)', () => {
        const p = projectExplodedJsonValue({});
        const entries = flattenProjection("r/values/nodeA", p);
        expect(entries).toHaveLength(1);
        expect(entries[0].virtualKey).toContain("\x00k\x00");
    });
});

// -------------------------------------------------------------------------
// 17. Scan projection
// -------------------------------------------------------------------------
describe('scan projection', () => {
    function makeReader(leaves) {
        const map = new Map();
        for (const l of leaves) {
            map.set(l.descendantPath, l.content);
        }
        return (path) => {
            if (!map.has(path)) {
                throw new MissingRenderedLeafError("", path, "unknown");
            }
            return map.get(path);
        };
    }

    test('scans string value', async () => {
        const p = projectExplodedJsonValue("hello");
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toBe("hello");
    });

    test('scans number value', async () => {
        const p = projectExplodedJsonValue(42);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toBe(42);
    });

    test('scans boolean true', async () => {
        const p = projectExplodedJsonValue(true);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toBe(true);
    });

    test('scans boolean false', async () => {
        const p = projectExplodedJsonValue(false);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toBe(false);
    });

    test('scans null', async () => {
        const p = projectExplodedJsonValue(null);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toBeNull();
    });

    test('scans nested object', async () => {
        const value = { a: { b: "deep" } };
        const p = projectExplodedJsonValue(value);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toEqual({ a: { b: "deep" } });
    });

    test('scans array', async () => {
        const value = ["a", 42, false, null];
        const p = projectExplodedJsonValue(value);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toEqual(["a", 42, false, null]);
    });

    test('scan(render(v)) = v round trip for mixed structure', async () => {
        const value = {
            name: "test",
            count: 42,
            active: true,
            metadata: null,
            tags: ["a", "b"],
            nested: { x: 1 },
            empty: {},
        };
        const p = projectExplodedJsonValue(value);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toEqual(value);
    });

    test('scans primitive-free array', async () => {
        const value = [{}, []];
        const p = projectExplodedJsonValue(value);
        const result = await scanExplodedJsonProjection(p.schema, makeReader(p.leaves));
        expect(result).toEqual([{}, []]);
    });
});

// -------------------------------------------------------------------------
// 18. Structural equality
// -------------------------------------------------------------------------
describe('jsonStructuralEquals', () => {
    test('equal primitives', () => {
        expect(jsonStructuralEquals(5, 5)).toBe(true);
        expect(jsonStructuralEquals("a", "a")).toBe(true);
        expect(jsonStructuralEquals(true, true)).toBe(true);
        expect(jsonStructuralEquals(null, null)).toBe(true);
    });

    test('unequal primitives', () => {
        expect(jsonStructuralEquals(5, 6)).toBe(false);
        expect(jsonStructuralEquals("a", "b")).toBe(false);
        expect(jsonStructuralEquals(true, false)).toBe(false);
        expect(jsonStructuralEquals(null, 5)).toBe(false);
    });

    test('negative zero equals zero', () => {
        expect(jsonStructuralEquals(-0, 0)).toBe(true);
    });

    test('objects with different insertion order are equal', () => {
        expect(jsonStructuralEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    test('arrays with same order are equal', () => {
        expect(jsonStructuralEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    });

    test('arrays with different order are not equal', () => {
        expect(jsonStructuralEquals([1, 2, 3], [3, 2, 1])).toBe(false);
    });

    test('nested structural equality', () => {
        const a = { items: [{ x: 1 }, { y: 2 }] };
        const b = { items: [{ x: 1 }, { y: 2 }] };
        expect(jsonStructuralEquals(a, b)).toBe(true);
    });
});
