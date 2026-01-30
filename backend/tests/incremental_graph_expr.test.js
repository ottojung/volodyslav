/**
 * Tests for incremental_graph/expr module.
 */

const {
    parseExpr,
    functor,
    canonicalizeMapping,
    renderExpr,
} = require("../src/generators/incremental_graph/expr");

describe("incremental_graph/expr", () => {
    describe("parseExpr()", () => {
        test("parses an atom", () => {
            const result = parseExpr("all_events");
            expect(result).toEqual({
                kind: "atom",
                name: "all_events",
                args: [],
            });
        });

        test("parses function call with no args (T4)", () => {
            const result = parseExpr("foo()");
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [],
            });
        });

        test("parses a function call with one identifier arg", () => {
            const result = parseExpr("event_context(e)");
            expect(result).toEqual({
                kind: "call",
                name: "event_context",
                args: [{ kind: "identifier", value: "e" }],
            });
        });

        test("parses a function call with multiple identifier args", () => {
            const result = parseExpr("enhanced_event(e,p)");
            expect(result).toEqual({
                kind: "call",
                name: "enhanced_event",
                args: [
                    { kind: "identifier", value: "e" },
                    { kind: "identifier", value: "p" },
                ],
            });
        });

        test("handles whitespace in atom", () => {
            const result = parseExpr("  all_events  ");
            expect(result).toEqual({
                kind: "atom",
                name: "all_events",
                args: [],
            });
        });

        test("handles whitespace in function call", () => {
            const result = parseExpr("  event_context( e )  ");
            expect(result).toEqual({
                kind: "call",
                name: "event_context",
                args: [{ kind: "identifier", value: "e" }],
            });
        });

        test("handles whitespace around commas", () => {
            const result = parseExpr("foo( a , b , c )");
            expect(result).toEqual({
                kind: "call",
                name: "foo",
                args: [
                    { kind: "identifier", value: "a" },
                    { kind: "identifier", value: "b" },
                    { kind: "identifier", value: "c" },
                ],
            });
        });



        test("throws on empty string", () => {
            expect(() => parseExpr("")).toThrow("Expression cannot be empty");
        });

        test("throws on missing closing paren", () => {
            expect(() => parseExpr("foo(a")).toThrow("rparen");
        });

        test("throws on invalid identifier in atom", () => {
            expect(() => parseExpr("123invalid")).toThrow("Unexpected character");
        });

        test("throws on invalid function name", () => {
            expect(() => parseExpr("123foo(x)")).toThrow("Unexpected character");
        });
    });

    describe("renderExpr()", () => {
        test("normalizes empty argument calls to atoms", () => {
            const expr = parseExpr("foo()");
            expect(renderExpr(expr)).toBe("foo");
        });
    });

    describe("functor()", () => {
        test("extracts a functor from an atom", () => {
            expect(functor("all_events")).toBe("all_events");
            expect(functor("  all_events  ")).toBe("all_events");
        });

        test("extracts functor from empty argument list", () => {
            expect(functor("foo()")).toBe("foo");
            expect(functor("foo( )")).toBe("foo");
        });

        test("extracts functor independent of variable names", () => {
            expect(functor("event_context(e)")).toBe("event_context");
            expect(functor("event_context( e )")).toBe("event_context");
            expect(functor("event_context(x)")).toBe("event_context");
        });

        test("extracts functor from multiple args", () => {
            expect(functor("foo(a,b,c)")).toBe("foo");
            expect(functor("foo( a , b , c )")).toBe("foo");
            expect(functor(" foo ( a , b , c ) ")).toBe("foo");
        });

        test("variable names don't affect functor extraction", () => {
            expect(functor("event_context(e)")).toBe("event_context");
            expect(functor("event_context(x)")).toBe("event_context");
            expect(functor("enhanced_event(e, p)")).toBe("enhanced_event");
            expect(functor("enhanced_event(x, y)")).toBe("enhanced_event");
        });

        test("throws on malformed expression", () => {
            expect(() => functor("")).toThrow();
            expect(() => functor("foo(")).toThrow();
        });
    });

    describe("canonicalizeMapping()", () => {
        test("canonicalizes simple atom mapping", () => {
            const inputExprs = [parseExpr("source")];
            const outputExpr = parseExpr("derived");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("source => derived");
        });

        test("canonicalizes mapping with function call inputs", () => {
            const inputExprs = [parseExpr("foo(x)")];
            const outputExpr = parseExpr("bar(x)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("foo(v0) => bar(v0)");
        });

        test("makes variable names irrelevant", () => {
            const inputExprs1 = [parseExpr("foo(x)")];
            const outputExpr1 = parseExpr("bar(x)");
            const result1 = canonicalizeMapping(inputExprs1, outputExpr1);

            const inputExprs2 = [parseExpr("foo(y)")];
            const outputExpr2 = parseExpr("bar(y)");
            const result2 = canonicalizeMapping(inputExprs2, outputExpr2);

            expect(result1).toBe(result2);
            expect(result1).toBe("foo(v0) => bar(v0)");
        });

        test("handles multiple inputs with atoms", () => {
            const inputExprs = [parseExpr("source1"), parseExpr("source2")];
            const outputExpr = parseExpr("derived");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("source1 + source2 => derived");
        });

        test("handles multiple inputs with function calls", () => {
            const inputExprs = [parseExpr("foo(x)"), parseExpr("bar(y)")];
            const outputExpr = parseExpr("baz(x,y)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("foo(v0) + bar(v1) => baz(v0,v1)");
        });

        test("handles same variable used multiple times", () => {
            const inputExprs = [parseExpr("foo(x)")];
            const outputExpr = parseExpr("bar(x,x)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("foo(v0) => bar(v0,v0)");
        });

        test("assigns variables in order of first appearance", () => {
            const inputExprs = [parseExpr("foo(x,y)")];
            const outputExpr = parseExpr("bar(y,x)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("foo(v0,v1) => bar(v1,v0)");
        });

        test("handles complex multi-input multi-variable mapping", () => {
            const inputExprs = [
                parseExpr("source(a)"),
                parseExpr("transform(b,c)"),
            ];
            const outputExpr = parseExpr("result(a,b,c)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("source(v0) + transform(v1,v2) => result(v0,v1,v2)");
        });

        test("different variable order same structure produces different result", () => {
            const inputExprs1 = [parseExpr("foo(x,y)")];
            const outputExpr1 = parseExpr("bar(x,y)");
            const result1 = canonicalizeMapping(inputExprs1, outputExpr1);

            const inputExprs2 = [parseExpr("foo(x,y)")];
            const outputExpr2 = parseExpr("bar(y,x)");
            const result2 = canonicalizeMapping(inputExprs2, outputExpr2);

            expect(result1).not.toBe(result2);
            expect(result1).toBe("foo(v0,v1) => bar(v0,v1)");
            expect(result2).toBe("foo(v0,v1) => bar(v1,v0)");
        });

        test("handles empty input array", () => {
            const inputExprs = [];
            const outputExpr = parseExpr("constant");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe(" => constant");
        });

        test("handles atom output with function call inputs", () => {
            const inputExprs = [parseExpr("foo(x)")];
            const outputExpr = parseExpr("bar");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("foo(v0) => bar");
        });

        test("handles function call output with atom inputs", () => {
            const inputExprs = [parseExpr("source")];
            const outputExpr = parseExpr("derived(x)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("source => derived(v0)");
        });

        test("normalizes empty-argument calls to atoms", () => {
            const inputExprs = [parseExpr("source()")];
            const outputExpr = parseExpr("derived()");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("source => derived");
        });

        test("variable scoping across inputs and outputs", () => {
            const inputExprs = [
                parseExpr("first(a,b)"),
                parseExpr("second(c)"),
            ];
            const outputExpr = parseExpr("third(b,c,a)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("first(v0,v1) + second(v2) => third(v1,v2,v0)");
        });

        test("handles many inputs", () => {
            const inputExprs = [
                parseExpr("in1"),
                parseExpr("in2"),
                parseExpr("in3"),
                parseExpr("in4"),
            ];
            const outputExpr = parseExpr("out");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("in1 + in2 + in3 + in4 => out");
        });

        test("distinguishes different structures with same variable names", () => {
            const inputExprs1 = [parseExpr("foo(x,y)")];
            const outputExpr1 = parseExpr("bar(x)");
            const result1 = canonicalizeMapping(inputExprs1, outputExpr1);

            const inputExprs2 = [parseExpr("foo(x)")];
            const outputExpr2 = parseExpr("bar(x,y)");
            const result2 = canonicalizeMapping(inputExprs2, outputExpr2);

            expect(result1).not.toBe(result2);
            expect(result1).toBe("foo(v0,v1) => bar(v0)");
            expect(result2).toBe("foo(v0) => bar(v0,v1)");
        });

        test("real-world example from schema validation", () => {
            // Simulates actual usage in class.js for schema hashing
            const inputExprs = [
                parseExpr("all_events"),
                parseExpr("event_context(e)"),
            ];
            const outputExpr = parseExpr("enhanced_event(e)");

            const result = canonicalizeMapping(inputExprs, outputExpr);

            expect(result).toBe("all_events + event_context(v0) => enhanced_event(v0)");
        });

        test("ensures stability: same inputs produce same output", () => {
            const inputExprs = [parseExpr("foo(x,y)")];
            const outputExpr = parseExpr("bar(y,x)");

            const result1 = canonicalizeMapping(inputExprs, outputExpr);
            const result2 = canonicalizeMapping(inputExprs, outputExpr);

            expect(result1).toBe(result2);
        });
    });
});
